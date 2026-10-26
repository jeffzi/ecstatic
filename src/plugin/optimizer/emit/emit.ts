/**
 * The rewrite of one file: the inlined loop that replaces each rewritten `each` call, and the
 * preamble those loops share, printed as the source text with them spliced in.
 *
 * The preamble holds nothing but the namespace import of the internal entry and the uninitialized
 * `var` slots of the call sites that cache a filter's matcher. A loop can run while its module is
 * still loading, when a circular import calls it before the module's body has run; an import
 * binding is live by then, and a `var` binding exists as `undefined`, but a top-level `const` is in
 * its temporal dead zone. So each guard carries its own copy of the runtime's `DEBUG` initializer
 * and its shape key as a literal, and a bundler's `NDEBUG` define folds the copy in place.
 *
 * It builds through the factory from the file's nodes, the node table, and the plan, and never
 * queries the checker.
 */

import {
  type Block,
  type CallExpression,
  type Expression,
  type Node,
  type NodeArray,
  NodeFlags,
  type SourceFile,
  type Statement,
  SyntaxKind,
} from "typescript/ast";
import {
  createBlock,
  createExpressionStatement,
  createForStatement,
  createIdentifier,
  createIfStatement,
  createImportClause,
  createImportDeclaration,
  createNamespaceImport,
  createPostfixUnaryExpression,
  createVariableDeclarationList,
} from "typescript/ast/factory";
import {
  isArrowFunction,
  isBlock,
  isCallExpression,
  isExpression,
  isExpressionStatement,
  isVariableDeclarationList,
} from "typescript/ast/is";
import { visitEachChild, visitNode } from "typescript/ast/visitor";

import { shapeKey, type ViewUse } from "../facts.js";
import { type NodeTable, tableNode } from "../nodes.js";
import type { EachInlining } from "../plan.js";
import type { Session } from "../session.js";
import { type InlineCallback, isInlineCallback } from "../syntax.js";
import { inCatalogOrder, type Rule } from "./catalog.js";
import { loadDebug } from "./debug.js";
import {
  assignTo,
  binary,
  commaList,
  constStatement,
  debugGated,
  declaration,
  letStatement,
  member,
  namespaceCall,
  numeric,
  string,
  type Visit,
} from "./expressions.js";
import { FILTER_LOCALS, FilterPass, type RowFilter, siteDeclarations } from "./filter.js";
import { Lowering } from "./lowering.js";
import { NameGenerator } from "./names.js";
import { printSpliced, type PrintedFile, type Replacement } from "./print.js";
import { RUNTIME_FILTER_LOCALS, RuntimeFilterPass } from "./runtime-filter.js";
import { expressionStatement, Transplant } from "./transplant.js";

/** The entry point generated code reaches the runtime through. */
const INTERNAL_MODULE = "ecstatic/internal";

/** The base name of each local every loop adds: the storage, its row count, and the row index. */
const LOOP_LOCALS = { storage: "storage", count: "n", row: "i" } as const;

/** How a file is rewritten. */
export interface EmitFileOptions {
  /** The ecstatic package root whose `DEBUG` initializer every shape guard copies. */
  readonly root: string;
  /**
   * Called with each inlining once its loop is built, before the file records the loop: the last
   * point a throw leaves the file as it was.
   */
  readonly beforeCommit?: (inlining: EachInlining) => void;
}

/** One source file whose `each` calls are being inlined. */
export interface EmitFile {
  /**
   * Replaces the call of `inlining` with the loops of `eachStorage` and `eachStorageMatched`
   * (`src/ecstatic/entity/each.ts`), lowering `uses`, the view uses of its callback. A throw
   * leaves the file as it was before the call, so the caller can keep that site's runtime call.
   *
   * @param inlining - The planned inlining.
   * @param uses - The view uses of the inlining's callback.
   * @throws Error when a node of the inlining is not in the node table, is not the call or
   *   callback it should be, or uses the view in a way that has no lowering; and whatever
   *   `beforeCommit` throws, leaving the file as it was.
   */
  inline(inlining: EachInlining, uses: readonly ViewUse[]): void;
  /** The rules of the rewrite catalog the loops inlined so far applied, in catalog order. */
  applied(): Rule[];
  /**
   * Prints the file with every inlined loop and the preamble spliced in.
   *
   * @returns The text, which is the source's own when nothing was inlined, and its source map.
   * @throws When the session cannot print.
   */
  print(): Promise<PrintedFile>;
}

/**
 * Starts the rewrite of `source`.
 *
 * @param session - The session that prints the file and parses the runtime's `DEBUG` initializer.
 * @param source - The file to rewrite.
 * @param table - The node table that maps the file's node IDs.
 * @param options - How the file is rewritten, and the runtime root its shape guards copy `DEBUG`
 *   from.
 * @returns The file, ready to inline its calls.
 * @throws When the root's `src/ecstatic/debug.ts` cannot be read or declares no top-level
 *   `DEBUG` with an initializer, naming the file; or when the session is closed or its process
 *   exited.
 */
export async function createEmitFile(
  session: Session,
  source: SourceFile,
  table: NodeTable,
  options: EmitFileOptions,
): Promise<EmitFile> {
  const debug = await loadDebug(session, options.root);
  return new File({ session, source, table, debug, options });
}

interface FileParts {
  readonly session: Session;
  readonly source: SourceFile;
  readonly table: NodeTable;
  readonly debug: Expression;
  readonly options: EmitFileOptions;
}

/** A file being rewritten, which records each loop only once it is fully built. */
class File implements EmitFile {
  readonly #parts: FileParts;
  readonly #replacements: Replacement[] = [];
  readonly #applied = new Set<Rule>();
  #names: NameGenerator;
  /**
   * The name of the namespace import of the internal entry that a file with at least one rewrite
   * declares once, ahead of its own statements. It must stay an import, whose binding is live
   * before the module's body runs.
   */
  #namespace: string | undefined;
  /** The file-level slot of every inlined call site that caches its filter's matcher. */
  readonly #sites: string[] = [];

  constructor(parts: FileParts) {
    this.#parts = parts;
    this.#names = new NameGenerator(parts.source);
  }

  inline(inlining: EachInlining, uses: readonly ViewUse[]): void {
    const { table, debug, options } = this.#parts;
    const call = tableNode(table, inlining.call, "call", isCallExpression);
    const names = new NameGenerator(this.#names);
    const namespace = this.#namespace ?? names.unique("ecstatic_internal");
    const applied = new Set<Rule>();
    const guard = { namespace, debug, key: shapeKey(inlining.shape) };
    const loop = new Loop({ table, inlining, names, applied, guard });
    const block = loop.build(call, uses);
    options.beforeCommit?.(inlining);

    const target = isExpressionStatement(call.parent) ? call.parent : call;
    this.#replacements.push({ target, node: block });
    this.#names = names;
    this.#namespace = namespace;
    if (loop.site !== undefined) this.#sites.push(loop.site);
    for (const rule of applied) this.#applied.add(rule);
  }

  applied(): Rule[] {
    return inCatalogOrder(this.#applied);
  }

  async print(): Promise<PrintedFile> {
    const namespace = this.#namespace;
    const preamble = namespace === undefined ? [] : this.#preambleStatements(namespace);
    const { session, source } = this.#parts;
    return await printSpliced(session, source, preamble, this.#replacements);
  }

  /**
   * The preamble's statements.
   *
   * @param namespace - The name the file's loops reach the internal entry through.
   * @returns The namespace import of the internal entry, then the declaration of the call-site
   *   slots, if any loop caches a matcher.
   */
  #preambleStatements(namespace: string): Statement[] {
    const clause = createImportClause(
      undefined,
      undefined,
      createNamespaceImport(createIdentifier(namespace)),
    );
    const statements: Statement[] = [
      createImportDeclaration(undefined, clause, string(INTERNAL_MODULE)),
    ];
    if (this.#sites.length > 0) statements.push(siteDeclarations(this.#sites));
    return statements;
  }
}

/** What a loop's shape guard is built from. */
interface GuardParts {
  /** The name of the preamble's namespace import of the internal entry. */
  readonly namespace: string;
  /** The runtime's `DEBUG` initializer, which the guard copies as its gate. */
  readonly debug: Expression;
  /** The literal the guard passes to `assertShape` as the shape the storage must match. */
  readonly key: string;
}

/** What a {@link Loop} builds from, and where it records its names and rules. */
interface LoopParts {
  readonly table: NodeTable;
  readonly inlining: EachInlining;
  readonly names: NameGenerator;
  readonly applied: Set<Rule>;
  readonly guard: GuardParts;
}

/** What rewrites the nodes of a loop's row body. */
interface RowRewrites {
  readonly lowering: Lowering;
  readonly transplant: Transplant;
  /** The shape key each spawn target the loop guards claims, by the target's node. */
  readonly spawnTargets: ReadonlyMap<Node, string>;
}

/** What the row part of a loop is built from. */
interface RowPass {
  readonly call: CallExpression;
  readonly callback: InlineCallback;
  readonly uses: readonly ViewUse[];
  /** The name of the loop's storage local. */
  readonly storage: string;
  readonly filter: RowFilter | undefined;
}

/**
 * The row loop, from the last row to the first.
 *
 * @param n - The name of the row count local.
 * @param i - The name of the row index.
 * @param body - The statements run for a visited row.
 * @param rowTest - The test a row must pass to be visited, or `undefined` to visit every row.
 * @returns `for (let i = n - 1; i >= 0; i--) { body }`, the body under `if (rowTest)` when given.
 */
function rowsFromLast(
  n: string,
  i: string,
  body: Statement[],
  rowTest: Expression | undefined,
): Statement {
  return createForStatement(
    createVariableDeclarationList(
      [declaration(i, binary(createIdentifier(n), SyntaxKind.MinusToken, numeric("1")))],
      NodeFlags.Let,
    ),
    binary(createIdentifier(i), SyntaxKind.GreaterThanEqualsToken, numeric("0")),
    createPostfixUnaryExpression(createIdentifier(i), SyntaxKind.MinusMinusToken),
    createBlock(
      rowTest === undefined ? body : [createIfStatement(rowTest, createBlock(body, true))],
      true,
    ),
  );
}

/** Builds the block that replaces one `each` call. */
class Loop {
  readonly #table: NodeTable;
  readonly #inlining: EachInlining;
  readonly #names: NameGenerator;
  readonly #applied: Set<Rule>;
  readonly #guard: GuardParts;
  #site: string | undefined;

  constructor({ table, inlining, names, applied, guard }: LoopParts) {
    this.#table = table;
    this.#inlining = inlining;
    this.#names = names;
    this.#applied = applied;
    this.#guard = guard;
  }

  /**
   * The file-level slot the loop caches its filter's resolution in, once {@link Loop.build} has
   * built a loop with one: a literal filter that folds to a matcher, or a filter resolved at
   * runtime.
   */
  get site(): string | undefined {
    return this.#site;
  }

  /**
   * The block replacing `call`, which mirrors `eachStorage` and `eachStorageMatched`
   * (`src/ecstatic/entity/each.ts`): the storage is evaluated once, then a literal filter's
   * elements in source order, before the guards; a filter that folds to a matcher reads it before
   * the row count is read once; and rows run from the last to the first, each visited when the
   * matcher flags it when the loop reaches it. A filter that folds to a skip leaves no loop. A
   * filter resolved at runtime is evaluated once into a temp and checked as the runtime checks its
   * arguments, then resolved through the slot on every call; the block then runs the unfiltered or
   * the filtered row loop, as the resolution says.
   *
   * @param call - The inlined call.
   * @param uses - The view uses of its callback.
   * @returns The block.
   * @throws Error when the call has no storage or no inline callback, or a use, return, spawn
   *   target, filter element, or filter resolved at runtime is not in the node table or has no
   *   lowering.
   */
  build(call: CallExpression, uses: readonly ViewUse[]): Block {
    const [storageArgument] = call.arguments;
    const callback = call.arguments.at(-1);
    if (storageArgument === undefined || callback === undefined || !isInlineCallback(callback)) {
      throw new Error("emit: the call has no storage or no inline callback");
    }
    const storage = this.#names.unique(LOOP_LOCALS.storage);
    const filter = this.#filterPass();
    const prologue = [
      constStatement([declaration(storage, storageArgument)]),
      ...(filter?.temps() ?? []),
      createExpressionStatement(this.#shapeGuard(createIdentifier(storage), this.#guard.key)),
      ...(filter?.guard(storage) ?? []),
    ];
    if (filter?.skips === true) return createBlock(prologue, true);
    const rows = this.#rowPass({ call, callback, uses, storage, filter });
    return createBlock([...prologue, ...rows], true);
  }

  /**
   * The statements after a loop's guards: a filter's matcher, then the row count, read once, and
   * the row loop when it is positive. A filter resolved at runtime runs them only when it resolves
   * to a matcher, and holds two row loops, each with its own copy of the body: one visiting every
   * row, taken for a matcher whose masks are 0, and one visiting the rows the matcher flags.
   *
   * @param pass - The call, its callback and view uses, the storage local, and the filter pass.
   * @returns The statements.
   * @throws Error when a use, return, or spawn target is not in the node table or has no lowering.
   */
  #rowPass(pass: RowPass): Statement[] {
    const { call, callback, uses, storage, filter } = pass;
    const matcher = filter?.matcher(storage) ?? [];
    this.#site = filter?.site;
    const n = this.#names.unique(LOOP_LOCALS.count);
    const i = this.#names.unique(LOOP_LOCALS.row);
    const { shape, mode } = this.#inlining;
    this.#applied.add(mode === "hoisted" ? "mode-hoisted" : "mode-realloc-safe");
    const lowering = new Lowering({
      shape,
      mode,
      names: this.#names,
      applied: this.#applied,
      storage,
      row: i,
    });
    for (const use of uses) lowering.collect(this.#table, use);
    const transplant = new Transplant({
      table: this.#table,
      inlining: this.#inlining,
      call,
      body: callback.body,
      names: this.#names,
      applied: this.#applied,
    });
    this.#noteCallback(callback);
    const rewrites = { lowering, transplant, spawnTargets: this.#spawnTargets() };
    const rowLoop = (rowTest: Expression | undefined): Statement =>
      transplant.labeled(rowsFromLast(n, i, this.#rowBody(callback, rewrites), rowTest));
    let loops: Statement[];
    if (filter instanceof RuntimeFilterPass) {
      const unfiltered = rowLoop(undefined);
      const filtered = [...filter.hoists(), rowLoop(filter.rowTest(i))];
      loops = [filter.branch(unfiltered, filtered)];
    } else {
      const filterHoists = filter?.hoists() ?? [];
      loops = [...filterHoists, rowLoop(filter?.rowTest(i))];
    }
    transplant.noteOuterReferences(call, callback, [
      ...Object.values(LOOP_LOCALS),
      ...filterLocals(filter),
      ...lowering.baseNames,
    ]);
    const counted = [
      constStatement([declaration(n, member(createIdentifier(storage), "n"))]),
      createIfStatement(
        binary(createIdentifier(n), SyntaxKind.GreaterThanToken, numeric("0")),
        createBlock([...lowering.hoists(), ...loops], true),
      ),
    ];
    if (filter instanceof RuntimeFilterPass) return [...matcher, filter.whenResolved(counted)];
    return [...matcher, ...counted];
  }

  /**
   * The parts the loop's filter adds, when it has one.
   *
   * @returns The pass of a literal filter or of one resolved at runtime, or `undefined` for a call
   *   without a filter argument.
   * @throws Error when an element of a literal filter, or a filter resolved at runtime, is not in
   *   the node table or is no expression.
   */
  #filterPass(): RowFilter | undefined {
    const { filter, mode } = this.#inlining;
    if (filter === undefined) return undefined;
    const { namespace, debug } = this.#guard;
    const parts = {
      table: this.#table,
      mode,
      names: this.#names,
      applied: this.#applied,
      namespace,
    };
    if ("form" in filter) return new RuntimeFilterPass({ ...parts, filter });
    return new FilterPass({ ...parts, filter, debug });
  }

  /**
   * A shape guard: the loop's runs once per call, before any row, and a spawn target's each time
   * the spawn is reached. Its gate is a parenthesized copy of the runtime's `DEBUG` initializer,
   * which reads no binding of the file, so the guard runs even before the module's body has.
   *
   * @param storage - The storage checked, an expression without side effects.
   * @param key - The shape key the storage must match.
   * @returns `(<DEBUG initializer>) && <namespace>.assertShape(storage, "<key>")`, through the
   *   file's namespace import.
   */
  #shapeGuard(storage: Expression, key: string): Expression {
    const { namespace, debug } = this.#guard;
    return debugGated(debug, namespaceCall(namespace, "assertShape", [storage, string(key)]));
  }

  /**
   * A spawn target checked against the shape its type claims before the spawn runs. A hoisted loop
   * holds the iterated storage's arrays across rows, so a target that is that storage under a cast
   * would grow it and leave the loop writing to replaced arrays. The target is evaluated once, in
   * place, into a temp, so stripping the guard under `NDEBUG` leaves its evaluation as written.
   *
   * @param target - The lowered target.
   * @param key - The shape key the target's type claims.
   * @param lowering - The loop's lowering, which declares the temp.
   * @returns `(<temp> = target, <guard of temp>, <temp>)`.
   */
  #guardedSpawnTarget(target: Expression, key: string, lowering: Lowering): Expression {
    const held = lowering.temp("target");
    return commaList(
      assignTo(createIdentifier(held), target),
      this.#shapeGuard(createIdentifier(held), key),
      createIdentifier(held),
    );
  }

  /**
   * The spawn targets the loop guards, by node.
   *
   * @returns The shape key each target's type claims, keyed by the target's node.
   * @throws Error when a target is not in the node table or is no expression.
   */
  #spawnTargets(): ReadonlyMap<Node, string> {
    return new Map(
      this.#inlining.spawnTargets.map(({ node, key }) => [
        tableNode(this.#table, node, "spawn target", isExpression),
        key,
      ]),
    );
  }

  /**
   * Records the rules of a callback's form: an arrow or a function expression, with no parameter
   * or an annotated one, and an expression body.
   *
   * @param callback - The inlined call's callback.
   */
  #noteCallback(callback: InlineCallback): void {
    this.#applied.add(isArrowFunction(callback) ? "callback-arrow" : "callback-function");
    const [parameter] = callback.parameters;
    if (parameter === undefined) this.#applied.add("callback-without-parameter");
    else if (parameter.type !== undefined) this.#applied.add("callback-typed-parameter");
    if (!isBlock(callback.body)) this.#applied.add("expression-body");
  }

  /**
   * The body of `callback`, run once per row.
   *
   * @param callback - The inlined call's callback.
   * @param rewrites - The loop's lowerings of the callback's view uses; its rewrite of the
   *   callback's returns, `var` declarations, and clashing labels; and the shape key each spawn
   *   target to guard claims, by node.
   * @returns The body's statements, with every view use lowered, every spawn target guarded, and
   *   its own returns, `var` declarations, and clashing labels transplanted, after the `let` that
   *   binds its `var` names
   *   afresh. A parameter pattern binds with `let` ahead of the body, which then runs in a block of
   *   its own, so the bindings stay assignable as parameters are, and their defaults see the
   *   enclosing scope but not the names the body declares.
   * @throws Error when a use has no lowering.
   */
  #rowBody(callback: InlineCallback, rewrites: RowRewrites): Statement[] {
    const { lowering, transplant, spawnTargets } = rewrites;
    const rewrite = (node: Node): Node => {
      transplant.noteBodyRule(node, callback);
      const use = lowering.useOf(node);
      if (use !== undefined) return lowering.lower(node, use, visit);
      const list = isVariableDeclarationList(node)
        ? lowering.declarationList(node, visit)
        : undefined;
      return list ?? transplant.visit(node, visit) ?? visitChildren(node, visit);
    };
    const visit: Visit = (node) => {
      const key = spawnTargets.get(node);
      if (key === undefined) return rewrite(node);
      return this.#guardedSpawnTarget(visitNode(node, rewrite, isExpression), key, lowering);
    };
    const [parameter] = callback.parameters;
    const parameters =
      parameter === undefined ? undefined : lowering.parameterBindings(parameter, visit);
    const { body } = callback;
    let statements: Statement[];
    if (isBlock(body)) {
      statements = transplant.statements(body.statements, visit);
      const bindings = transplant.bindings(body.statements);
      if (bindings !== undefined) statements.unshift(bindings);
    } else {
      statements = [expressionStatement(visitNode(body, visit, isExpression))];
    }
    if (parameters === undefined) return statements;
    return [letStatement(parameters), createBlock(statements, true)];
  }
}

/**
 * The base names of the locals a loop's filter adds.
 *
 * @param filter - The loop's filter pass, if any.
 * @returns The names, none for a loop without a filter.
 */
function filterLocals(filter: RowFilter | undefined): string[] {
  if (filter === undefined) return [];
  return Object.values(filter instanceof RuntimeFilterPass ? RUNTIME_FILTER_LOCALS : FILTER_LOCALS);
}

/**
 * Visits the children of `node`, keeping every list the visit rebuilds as free of a trailing
 * comma as the source list was.
 *
 * The printer reads a list's trailing comma from positions: the list ends past its last element.
 * The tree it prints carries a factory node's position as 0, so a rebuilt list whose last element
 * the visit replaced would read as ending past it, and print a comma the source never had. Such a
 * list is given the synthesized end -1, which reaches the printer as 0 as well. A source list with
 * a trailing comma keeps its end, and prints its comma whether or not its last element was
 * replaced.
 *
 * @param node - The node whose children to visit.
 * @param visit - Visits each child.
 * @returns `node` when the visit changed no child, else the updated node.
 */
function visitChildren(node: Node, visit: Visit): Node {
  const updated = visitEachChild(node, visit);
  if (updated === node) return updated;
  const before = childLists(node);
  const after = childLists(updated);
  for (const [index, list] of after.entries()) {
    const source = before[index];
    if (list !== source && source?.hasTrailingComma !== true) {
      // The visit built `list` afresh, so moving its end moves no position of the source tree.
      Object.assign(list, { end: -1 });
    }
  }
  return updated;
}

/**
 * The child lists of `node`, in the order its children are visited.
 *
 * @param node - The node whose lists to collect.
 * @returns The lists.
 */
function childLists(node: Node): NodeArray<Node>[] {
  const lists: NodeArray<Node>[] = [];
  node.forEachChild(
    () => undefined,
    (nodes) => {
      lists.push(nodes);
      return undefined;
    },
  );
  return lists;
}
