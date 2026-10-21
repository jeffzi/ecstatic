/**
 * The rewrite of one file: the inlined loop that replaces each rewritten `each` call, and the
 * preamble those loops share, printed as the source text with them spliced in.
 *
 * It builds through the factory from the file's nodes, the node table, and the plan, and never
 * queries the checker.
 */

import {
  type Block,
  type CallExpression,
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
import { type Debug, loadDebug } from "./debug.js";
import {
  binary,
  constStatement,
  declaration,
  letStatement,
  member,
  numeric,
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

/** What a file with at least one rewrite declares once, ahead of its own statements. */
interface Preamble {
  readonly namespace: string;
  readonly debug: string;
  /** The name of the constant holding each shape key, in the order the loops first use them. */
  readonly keys: ReadonlyMap<string, string>;
}

/** How a file is rewritten. */
export interface EmitFileOptions {
  /** The ecstatic package root whose `DEBUG` initializer the preamble copies. */
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
 * @param session - The session that prints the file and parses the runtime's `DEBUG` gate.
 * @param source - The file to rewrite.
 * @param table - The node table that maps the file's node IDs.
 * @param options - How the file is rewritten, and the runtime root it copies `DEBUG` from.
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
  readonly debug: Debug;
  readonly options: EmitFileOptions;
}

/** A file being rewritten, which records each loop only once it is fully built. */
class File implements EmitFile {
  readonly #parts: FileParts;
  readonly #replacements: Replacement[] = [];
  readonly #applied = new Set<Rule>();
  #names: NameGenerator;
  #preamble: Preamble | undefined;

  constructor(parts: FileParts) {
    this.#parts = parts;
    this.#names = new NameGenerator(parts.source);
  }

  inline(inlining: EachInlining, uses: readonly ViewUse[]): void {
    const { table, options } = this.#parts;
    const call = tableNode(table, inlining.call, "call", isCallExpression);
    const names = new NameGenerator(this.#names);
    const { preamble, key } = nextPreamble(this.#preamble, names, shapeKey(inlining.shape));
    const applied = new Set<Rule>();
    const guard = { ...preamble, key };
    const block = new Loop({ table, inlining, names, applied, guard }).build(call, uses);
    options.beforeCommit?.(inlining);

    const target = isExpressionStatement(call.parent) ? call.parent : call;
    this.#replacements.push({ target, node: block });
    this.#names = names;
    this.#preamble = preamble;
    for (const rule of applied) this.#applied.add(rule);
  }

  applied(): Rule[] {
    return inCatalogOrder(this.#applied);
  }

  async print(): Promise<PrintedFile> {
    const preamble = this.#preamble === undefined ? [] : this.#preambleStatements(this.#preamble);
    const { session, source } = this.#parts;
    return await printSpliced(session, source, preamble, this.#replacements);
  }

  /**
   * The preamble's statements.
   *
   * @param preamble - The names and shape keys the file's loops use.
   * @returns The namespace import of the internal entry, the file's `DEBUG` copy, and one
   *   constant per shape key.
   */
  #preambleStatements(preamble: Preamble): Statement[] {
    const clause = createImportClause(
      undefined,
      undefined,
      createNamespaceImport(createIdentifier(preamble.namespace)),
    );
    const debug = getSynthesizedDeepClone(this.#parts.debug.initializer);
    return [
      createImportDeclaration(undefined, clause, string(INTERNAL_MODULE)),
      constStatement([declaration(preamble.debug, debug)]),
      ...[...preamble.keys].map(([key, name]) => constStatement([declaration(name, string(key))])),
    ];
  }
}

/**
 * The preamble once a loop over a shape key is added: a copy, so a loop that fails to build leaves
 * the file's preamble as it was.
 *
 * @param current - The file's preamble, undefined before its first loop.
 * @param names - The generator the preamble's new names come from.
 * @param key - The loop's shape key.
 * @returns The preamble, and the name of the constant that holds `key`.
 */
function nextPreamble(
  current: Preamble | undefined,
  names: NameGenerator,
  key: string,
): { preamble: Preamble; key: string } {
  const base = current ?? {
    namespace: names.unique("ecstatic_internal"),
    debug: names.unique("DEBUG"),
    keys: new Map<string, string>(),
  };
  const known = base.keys.get(key);
  if (known !== undefined) return { preamble: base, key: known };
  const name = names.unique("shapeKey");
  return { preamble: { ...base, keys: new Map([...base.keys, [key, name]]) }, key: name };
}

/** The names a loop's shape guard reads: the preamble's, and the constant of its own shape key. */
interface GuardNames {
  readonly namespace: string;
  readonly debug: string;
  readonly key: string;
}

/** What a {@link Loop} builds from, and where it records its names and rules. */
interface LoopParts {
  readonly table: NodeTable;
  readonly inlining: EachInlining;
  readonly names: NameGenerator;
  readonly applied: Set<Rule>;
  readonly guard: GuardNames;
}

/** Builds the block that replaces one `each` call. */
class Loop {
  readonly #table: NodeTable;
  readonly #inlining: EachInlining;
  readonly #names: NameGenerator;
  readonly #applied: Set<Rule>;
  readonly #guard: GuardNames;

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
   * @throws Error when the call has no storage or no inline callback, or a use or return is
   *   not in the node table or has no lowering.
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
    const body = this.#rowBody(callback, lowering, transplant);
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
        this.#shapeGuard(storage),
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
   * The shape guard, run once per call, before any row.
   *
   * @param storage - The name of the local holding the storage.
   * @returns `DEBUG && ecstatic_internal.assertShape(storage, shapeKey)`.
   */
  #shapeGuard(storage: string): Statement {
    const { namespace, debug, key } = this.#guard;
    const guarded = createCallExpression(
      member(createIdentifier(namespace), "assertShape"),
      undefined,
      undefined,
      [createIdentifier(storage), createIdentifier(key)],
      NodeFlags.None,
    );
    return createExpressionStatement(
      binary(createIdentifier(debug), SyntaxKind.AmpersandAmpersandToken, guarded),
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
   * @param lowering - The loop's lowerings of the callback's view uses.
   * @param transplant - The loop's rewrite of the callback's returns, `var` declarations, and
   *   clashing labels.
   * @returns The body's statements, with every view use lowered and its own returns, `var`
   *   declarations, and clashing labels transplanted, after the `let` that binds its `var` names
   *   afresh. A parameter pattern binds with `let` ahead of the body, which then runs in a block of
   *   its own, so the bindings stay assignable as parameters are, and their defaults see the
   *   enclosing scope but not the names the body declares.
   * @throws Error when a use has no lowering.
   */
  #rowBody(callback: InlineCallback, lowering: Lowering, transplant: Transplant): Statement[] {
    const visit: Visit = (node) => {
      transplant.noteBodyRule(node, callback);
      const use = lowering.useOf(node);
      if (use !== undefined) return lowering.lower(node, use, visit);
      const list = isVariableDeclarationList(node)
        ? lowering.declarationList(node, visit)
        : undefined;
      return list ?? transplant.visit(node, visit) ?? visitChildren(node, visit);
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
