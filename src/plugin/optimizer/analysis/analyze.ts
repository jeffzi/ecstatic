import type { CallExpression, Expression, Node, SourceFile } from "typescript/ast";
import {
  isArrayLiteralExpression,
  isArrowFunction,
  isCallExpression,
  isExpressionStatement,
} from "typescript/ast/is";

import { type Checker, sourceFileName } from "../compiler.js";
import {
  type ArchShape,
  type Callback,
  type Filter,
  iterates,
  matchesArgCount,
  type NodeID,
  type Reason,
  type Site,
  type StmtContext,
} from "../facts.js";
import { NodeTable } from "../nodes.js";
import { nodePosition } from "../position.js";
import type { InlineCallback } from "../syntax.js";
import { type CallbackScope, inlineCallback, prepareCallback } from "./callback.js";
import { type FilterReading, readFilter } from "./filter.js";
import { type PackageRoots, type Recognized, recognize } from "./roots.js";
import { resolveShapes } from "./shape.js";

/** The ecstatic call sites of one source file, with the node table their node IDs index. */
export interface FileAnalysis {
  /** The top-level sites in source order; a site inside an inline callback is in its call's `nested`. */
  readonly sites: readonly Site[];
  readonly table: NodeTable;
}

/**
 * Reports the ecstatic call sites of a file in source order. A site found inside the inline
 * callback of an `each` or `query` call is listed in that site's `nested`, not at the top level. A
 * file inside an ecstatic package's runtime (its `src/` or `dist/`) yields no sites, so the runtime
 * never rewrites its own calls.
 *
 * Every query the file needs is issued concurrently; the nodes the sites report are then
 * registered depth-first in source order, so analyzing the same file again gives equal sites.
 *
 * @param checker - Checker of the program holding `file`.
 * @param file - The file to analyze.
 * @param roots - The package root cache, shared across the files of a run.
 * @returns The sites and the table their node IDs index.
 * @throws When a consulted declaration's source file is no longer available.
 */
export async function analyze(
  checker: Checker,
  file: SourceFile,
  roots: PackageRoots,
): Promise<FileAnalysis> {
  const table = new NodeTable();
  if (roots.runtimeRoot(sourceFileName(file)) !== undefined) return { sites: [], table };
  const calls = callsIn(file);
  const recognized = await Promise.all(calls.map(async (call) => recognize(checker, roots, call)));
  const found = new Map<Node, RecognizedCall>();
  for (const [i, call] of calls.entries()) {
    const site = recognized[i];
    if (site !== undefined) found.set(call, { ...site, call });
  }
  const drafts: Draft[] = [];
  collect(file, found, table, drafts);
  const scope: CallbackScope = { checker, roots, table, file };
  const prepared = await Promise.all(drafts.map(async (draft) => prepareTree(scope, draft)));
  return { sites: prepared.map(finish), table };
}

/** A call into an ecstatic runtime, with its node. */
interface RecognizedCall extends Recognized {
  readonly call: CallExpression;
}

/** A recognized call, its node registered, before its facts are gathered. */
interface Draft extends RecognizedCall {
  readonly id: NodeID;
  readonly callback: InlineCallback | undefined;
  /** The drafts inside the call's inline callback, in source order. */
  readonly nested: Draft[];
}

/** A site whose queries have all answered, its callback's nodes not yet registered. */
interface PreparedSite {
  readonly site: Site;
  readonly registerFilter: (() => Filter) | undefined;
  readonly register: (() => Callback) | undefined;
  readonly nested: readonly PreparedSite[];
}

/**
 * Lists the call expressions under a node.
 *
 * @param node - The node to search.
 * @param calls - The list the calls are appended to.
 * @returns `calls`, holding every call under `node` in source order.
 */
function callsIn(node: Node, calls: CallExpression[] = []): CallExpression[] {
  node.forEachChild((child) => {
    if (isCallExpression(child)) calls.push(child);
    callsIn(child, calls);
  });
  return calls;
}

/**
 * Appends the drafts in a subtree, in source order, registering each call. The drafts in an
 * iteration callback become its call's nested drafts; any other operand's drafts follow the call's
 * own at the same level.
 *
 * @param node - The subtree's root.
 * @param found - The recognized calls of the file, keyed by node.
 * @param table - The file's node table.
 * @param drafts - The list the drafts are appended to.
 */
function collect(
  node: Node,
  found: ReadonlyMap<Node, RecognizedCall>,
  table: NodeTable,
  drafts: Draft[],
): void {
  const recognized = found.get(node);
  if (recognized === undefined) {
    node.forEachChild((child) => {
      collect(child, found, table, drafts);
    });
    return;
  }
  const callback = inlineCallback(recognized.call, recognized.op);
  const draft: Draft = { ...recognized, id: table.register(node), callback, nested: [] };
  drafts.push(draft);
  node.forEachChild((child) => {
    collect(child, found, table, child === callback ? draft.nested : drafts);
  });
}

/**
 * Gathers the facts of a draft and of every draft nested in it, concurrently.
 *
 * @param scope - The file, with the checker, root cache, and node table.
 * @param draft - The draft to prepare.
 * @returns The prepared site and its prepared nested sites.
 * @throws When a consulted declaration's source file is no longer available.
 */
async function prepareTree(scope: CallbackScope, draft: Draft): Promise<PreparedSite> {
  const [own, nested] = await Promise.all([
    prepareSite(scope, draft),
    Promise.all(draft.nested.map(async (inner) => prepareTree(scope, inner))),
  ]);
  return { ...own, nested };
}

/**
 * Gathers the facts of one site: its argument count, how an `each` passes its storages and filter
 * and what they resolve to, and the queries its inline callback needs.
 *
 * @param scope - The file, with the checker, root cache, and node table.
 * @param draft - The draft of the site.
 * @returns The site, with no filter, callback, or nested sites yet, and the registrations of its
 *   filter and callback.
 * @throws When a consulted declaration's source file is no longer available.
 */
async function prepareSite(
  scope: CallbackScope,
  draft: Draft,
): Promise<Omit<PreparedSite, "nested">> {
  const { call, op } = draft;
  const args = call.arguments;
  const mismatch = iterates(op) && !matchesArgCount(op, args.length);
  // A call that keeps its runtime form never needs its shapes.
  const storages = op === "each" && !mismatch ? args[0] : undefined;
  const filter = args.length === 3 ? args[1] : undefined;
  const each = storages === undefined ? NO_EACH : await readEach(scope, storages, filter);
  const reasons: Reason[] = mismatch ? ["ARG_COUNT"] : [];
  if (each.reason !== undefined) reasons.push(each.reason);
  const site: Site = {
    callback: undefined,
    reasons,
    nested: [],
    shapes: each.shapes,
    declarationFiles: [...each.declarationFiles],
    root: draft.root,
    pos: nodePosition(scope.file, call),
    call: draft.id,
    op,
    context: statementContext(call),
    filtered: each.filter !== undefined,
    arrayLiteral: each.arrayLiteral,
  };
  const register =
    draft.callback === undefined ? undefined : await prepareCallback(scope, site, draft.callback);
  return { site, registerFilter: each.filter?.register, register };
}

/** What the storages and filter arguments of an `each` call resolve to. */
interface EachReading {
  /** One shape for a single storage, one per element for an array literal; empty when unresolved. */
  readonly shapes: readonly ArchShape[];
  /** Why the shapes are not known statically; undefined when they resolved. */
  readonly reason: Reason | undefined;
  /** The filter argument's reading; undefined when the call passes none. */
  readonly filter: FilterReading | undefined;
  /** The declaration files both readings consulted, sorted and without duplicates. */
  readonly declarationFiles: readonly string[];
  readonly arrayLiteral: boolean;
}

/** The reading of a call that is no `each`, or one that keeps its runtime form. */
const NO_EACH: EachReading = {
  shapes: [],
  reason: undefined,
  filter: undefined,
  declarationFiles: [],
  arrayLiteral: false,
};

/**
 * Resolves the storages and reads the filter of an `each` call.
 *
 * @param scope - The file, with the checker and node table.
 * @param storages - The call's storages argument.
 * @param filterArg - The call's filter argument; undefined when it passes none.
 * @returns The storages' shapes or the reason they did not resolve, and the filter's reading,
 *   with the files both consulted.
 * @throws When a consulted declaration's source file is no longer available.
 */
async function readEach(
  scope: CallbackScope,
  storages: Expression,
  filterArg: Expression | undefined,
): Promise<EachReading> {
  const [resolution, filter] = await Promise.all([
    resolveShapes(scope.checker, storages),
    filterArg === undefined ? undefined : readFilter(scope.checker, scope.table, filterArg),
  ]);
  const declarationFiles = new Set([
    ...resolution.declarationFiles,
    ...(filter?.declarationFiles ?? []),
  ]);
  return {
    shapes: resolution.shapes,
    reason: resolution.reason,
    filter,
    declarationFiles: [...declarationFiles].toSorted(),
    arrayLiteral: isArrayLiteralExpression(storages),
  };
}

/**
 * Registers the filter and callback nodes of a prepared site, in that source order, then those of
 * its nested sites, depth-first.
 *
 * @param prepared - The prepared site.
 * @returns The finished site.
 */
function finish(prepared: PreparedSite): Site {
  const filter = prepared.registerFilter?.();
  const callback = prepared.register?.();
  const site: Site = { ...prepared.site, callback, nested: prepared.nested.map(finish) };
  return filter === undefined ? site : { ...site, filter };
}

/**
 * Classifies where a call sits relative to the statement holding it.
 *
 * @param call - The call.
 * @returns The call's statement context.
 */
function statementContext(call: CallExpression): StmtContext {
  const { parent } = call;
  if (isExpressionStatement(parent)) return "expression-statement";
  if (isArrowFunction(parent) && parent.body === call) return "arrow-body";
  return "other-expression";
}
