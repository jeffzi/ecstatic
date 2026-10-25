/**
 * The rewrite of one file: the inlined loop that replaces each rewritten `each` call, and the
 * preamble those loops share, printed as the source text with them spliced in.
 *
 * The preamble holds nothing but the namespace import of the internal entry. A loop can run while
 * its module is still loading, when a circular import calls it before the module's body has run;
 * an import binding is live by then, a top-level `const` is not. So each shape guard carries its
 * own copy of the runtime's `DEBUG` initializer and its shape key as a literal, and a bundler's
 * `NDEBUG` define folds the copy in place.
 *
 * It builds through the factory from the file's nodes, the node table, and the plan, and never
 * queries the checker.
 */

import {
  type Block,
  type CallExpression,
  type Expression,
  getSynthesizedDeepClone,
  type Node,
  type NodeArray,
  NodeFlags,
  type SourceFile,
  type Statement,
  SyntaxKind,
} from "typescript/ast";
import {
  createBlock,
  createCallExpression,
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
  declaration,
  letStatement,
  member,
  numeric,
  parenthesized,
  string,
  type Visit,
} from "./expressions.js";
import { Lowering } from "./lowering.js";
import { NameGenerator } from "./names.js";
import { printSpliced, type PrintedFile, type Replacement } from "./print.js";
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
   * Replaces the call of `inlining` with the loop of `eachStorageMatched`
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
    const block = new Loop({ table, inlining, names, applied, guard }).build(call, uses);
    options.beforeCommit?.(inlining);

    const target = isExpressionStatement(call.parent) ? call.parent : call;
    this.#replacements.push({ target, node: block });
    this.#names = names;
    this.#namespace = namespace;
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
   * @returns The namespace import of the internal entry.
   */
  #preambleStatements(namespace: string): Statement[] {
    const clause = createImportClause(
      undefined,
      undefined,
      createNamespaceImport(createIdentifier(namespace)),
    );
    return [createImportDeclaration(undefined, clause, string(INTERNAL_MODULE))];
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

/** Builds the block that replaces one `each` call. */
class Loop {
  readonly #table: NodeTable;
  readonly #inlining: EachInlining;
  readonly #names: NameGenerator;
  readonly #applied: Set<Rule>;
  readonly #guard: GuardParts;

  constructor({ table, inlining, names, applied, guard }: LoopParts) {
    this.#table = table;
    this.#inlining = inlining;
    this.#names = names;
    this.#applied = applied;
    this.#guard = guard;
  }

  /**
   * The block replacing `call`, which mirrors `eachStorageMatched` (`src/ecstatic/entity/each.ts`)
   * for a storage with no active matcher: the storage is evaluated once, the row count is read
   * once, and rows run from the last to the first.
   *
   * @param call - The inlined call.
   * @param uses - The view uses of its callback.
   * @returns The block.
   * @throws Error when the call has no storage or no inline callback, or a use, return, or spawn
   *   target is not in the node table or has no lowering.
   */
  build(call: CallExpression, uses: readonly ViewUse[]): Block {
    const [storageArgument] = call.arguments;
    const callback = call.arguments.at(-1);
    if (storageArgument === undefined || callback === undefined || !isInlineCallback(callback)) {
      throw new Error("emit: the call has no storage or no inline callback");
    }
    const storage = this.#names.unique(LOOP_LOCALS.storage);
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
    const body = this.#rowBody(callback, {
      lowering,
      transplant,
      spawnTargets: this.#spawnTargets(),
    });
    const rowLoop = createForStatement(
      createVariableDeclarationList(
        [declaration(i, binary(createIdentifier(n), SyntaxKind.MinusToken, numeric("1")))],
        NodeFlags.Let,
      ),
      binary(createIdentifier(i), SyntaxKind.GreaterThanEqualsToken, numeric("0")),
      createPostfixUnaryExpression(createIdentifier(i), SyntaxKind.MinusMinusToken),
      createBlock(body, true),
    );
    transplant.noteOuterReferences(call, callback, [
      ...Object.values(LOOP_LOCALS),
      ...lowering.baseNames,
    ]);
    return createBlock(
      [
        constStatement([declaration(storage, storageArgument)]),
        createExpressionStatement(this.#shapeGuard(createIdentifier(storage), this.#guard.key)),
        constStatement([declaration(n, member(createIdentifier(storage), "n"))]),
        createIfStatement(
          binary(createIdentifier(n), SyntaxKind.GreaterThanToken, numeric("0")),
          createBlock([...lowering.hoists(), transplant.labeled(rowLoop)], true),
        ),
      ],
      true,
    );
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
    const assertion = createCallExpression(
      member(createIdentifier(namespace), "assertShape"),
      undefined,
      undefined,
      [storage, string(key)],
      NodeFlags.None,
    );
    const gate = parenthesized(getSynthesizedDeepClone(debug));
    return binary(gate, SyntaxKind.AmpersandAmpersandToken, assertion);
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
