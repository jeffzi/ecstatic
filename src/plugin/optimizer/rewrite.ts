/**
 * Rewrites one module: analyzes it, plans its sites, and turns every planned `each` call into a loop,
 * isolating each failure to the site or file it struck.
 */
import type { SourceFile } from "typescript/ast";

import { analyze, type FileAnalysis } from "./analysis/analyze.js";
import { PackageRoots } from "./analysis/roots.js";
import type { FileBail } from "./diagnostics.js";
import { debugPath } from "./emit/debug.js";
import { createEmitFile, type EmitFile } from "./emit/emit.js";
import type { PrintedFile } from "./emit/print.js";
import type { NodeID, Site, ViewUse } from "./facts.js";
import { type Bail, type EachInlining, plan, thrownMessage } from "./plan.js";
import type { ProjectView, Session } from "./session.js";

/** One module after analysis, plan, and emit. */
export interface RewrittenModule {
  /** The rewritten text and its source map; `undefined` when no call was rewritten. */
  readonly output: PrintedFile | undefined;
  /** The calls that keep their runtime form, in plan order, then those whose rewrite failed. */
  readonly bails: readonly Bail[];
  /** Set when analyzing the file threw; the file is then left unchanged and `bails` is empty. */
  readonly fileBail: FileBail | undefined;
  /**
   * The declaration files the shape resolution of the module's sites consulted, and the
   * `src/ecstatic/debug.ts` its `DEBUG` copy came from when a call was rewritten; sorted and unique.
   * A change to any of them can change the rewrite.
   */
  readonly consulted: readonly string[];
}

/** Replaceable steps of a rewrite, so a test can make one of them throw. */
export interface RewriteSeams {
  /** Analyzes a file; {@link analyze} when absent. */
  readonly analyze?: typeof analyze;
  /** Emits one planned rewrite into the file; `file.inline` when absent. */
  readonly inline?: (file: EmitFile, inlining: EachInlining, uses: readonly ViewUse[]) => void;
}

/** Rewrites the modules of one project, sharing one package root cache across them. */
export interface Rewriter {
  /**
   * Rewrites a project file as `view` serves it.
   *
   * A call whose rewrite throws, or that resolves to another package root than the file's first
   * rewritten call, keeps its runtime call and becomes an `INTERNAL` bail; the file's other calls
   * are still rewritten. When that root's `DEBUG` copy cannot be taken, every planned rewrite
   * becomes an `INTERNAL` bail and the file is left unchanged. When analyzing the file throws, the
   * file is left unchanged and reported as one file bail.
   *
   * @param view - The project as the session serves it.
   * @param file - Absolute name of the file to rewrite.
   * @returns The rewritten module, its bails, and the files the rewrite depends on.
   * @throws When the file is not part of the program, the session is closed or its process
   *   exited, or the session cannot print the rewritten file; and when reading a site's call, op,
   *   or position throws, or the plan names a call analysis did not report: an analysis bug.
   */
  rewrite(view: ProjectView, file: string): Promise<RewrittenModule>;
}

/**
 * Creates a rewriter over the project `session` loaded.
 *
 * @param session - The session that parses the runtime's `DEBUG` gate and prints rewritten files.
 * @param seams - Steps that replace the rewriter's own.
 * @returns The rewriter.
 */
export function createRewriter(session: Session, seams: RewriteSeams = {}): Rewriter {
  const context: RewriteContext = {
    session,
    roots: new PackageRoots(),
    analyze: seams.analyze ?? analyze,
    inline: seams.inline ?? inlineInto,
  };
  return { rewrite: (view, file) => rewriteModule(context, view, file) };
}

/** What every rewrite of one {@link Rewriter} shares. */
interface RewriteContext {
  readonly session: Session;
  readonly roots: PackageRoots;
  readonly analyze: typeof analyze;
  readonly inline: NonNullable<RewriteSeams["inline"]>;
}

interface Emitted {
  /** The file and the `DEBUG` copy's source, when at least one call was inlined. */
  readonly inlined: { readonly file: EmitFile; readonly debug: string } | undefined;
  /** The planned rewrites that keep their runtime call, as `INTERNAL` bails. */
  readonly failed: readonly Bail[];
}

/**
 * Emits `inlining` into `file`, lowering `uses`.
 *
 * @param file - The file being rewritten.
 * @param inlining - The planned rewrite.
 * @param uses - The view uses of the rewrite's callback.
 * @throws Whatever {@link EmitFile.inline} throws.
 */
function inlineInto(file: EmitFile, inlining: EachInlining, uses: readonly ViewUse[]): void {
  file.inline(inlining, uses);
}

/**
 * Rewrites the project file `file`, as {@link Rewriter.rewrite} describes.
 *
 * @param context - What the rewriter's rewrites share.
 * @param view - The project as the session serves it.
 * @param file - Absolute name of the file to rewrite.
 * @returns The rewritten module.
 * @throws When the file is not part of the program, or the session cannot serve or print it; and
 *   when reading a site's call, op, or position throws, or the plan names a call analysis did not
 *   report: an analysis bug.
 */
async function rewriteModule(
  context: RewriteContext,
  view: ProjectView,
  file: string,
): Promise<RewrittenModule> {
  const source = await view.sourceFile(file);
  let analysis: FileAnalysis;
  try {
    analysis = await context.analyze(view.checker, source, context.roots);
  } catch (error) {
    return {
      output: undefined,
      bails: [],
      fileBail: {
        reason: "INTERNAL",
        pos: { file, offset: 0, line: 1, column: 1 },
        detail: thrownMessage(error),
      },
      consulted: [],
    };
  }
  const { bails, rewrites } = plan(analysis.sites);
  const { inlined, failed } = await emitRewrites(context, source, analysis, rewrites);
  const consulted = declarationFiles(analysis.sites);
  if (inlined !== undefined) consulted.push(inlined.debug);
  return {
    output: inlined === undefined ? undefined : await inlined.file.print(),
    bails: [...bails, ...failed],
    fileBail: undefined,
    consulted: [...new Set(consulted)].toSorted(),
  };
}

/**
 * Emits every rewrite of `rewrites` into `source` that it can, copying the `DEBUG` gate of the
 * package root the first rewritten call resolves to.
 *
 * @param context - What the rewriter's rewrites share.
 * @param source - The file to rewrite.
 * @param analysis - The file's sites and the node table their IDs index.
 * @param rewrites - The planned rewrites of the file's sites.
 * @returns The file when a call was inlined, and the rewrites that failed: those of another root,
 *   those whose inlining threw, and every one when the `DEBUG` gate cannot be copied.
 * @throws Error when a rewrite's call is no site of `analysis`.
 */
async function emitRewrites(
  context: RewriteContext,
  source: SourceFile,
  analysis: FileAnalysis,
  rewrites: readonly EachInlining[],
): Promise<Emitted> {
  const [first] = rewrites;
  if (first === undefined) return { inlined: undefined, failed: [] };
  const byCall = indexSites(analysis.sites);
  const { root } = siteOf(byCall, first.call);
  let file: EmitFile;
  try {
    file = await createEmitFile(context.session, source, analysis.table, { root });
  } catch (error) {
    const detail = thrownMessage(error);
    return { inlined: undefined, failed: rewrites.map((rewrite) => internalBail(rewrite, detail)) };
  }
  const failed: Bail[] = [];
  for (const rewrite of rewrites) {
    const site = siteOf(byCall, rewrite.call);
    if (site.root !== root) {
      failed.push(internalBail(rewrite, otherRootDetail(site.root, root)));
      continue;
    }
    try {
      context.inline(file, rewrite, site.callback?.viewUses ?? []);
    } catch (error) {
      failed.push(internalBail(rewrite, thrownMessage(error)));
    }
  }
  const debug = debugPath(root);
  return { inlined: failed.length === rewrites.length ? undefined : { file, debug }, failed };
}

/**
 * The detail of the bail of a call that resolves to another package root than the file's.
 *
 * @param root - The package root the call resolves to.
 * @param copied - The package root the file's `DEBUG` copy comes from.
 * @returns The detail.
 */
function otherRootDetail(root: string, copied: string): string {
  return `the call resolves to the ecstatic package root ${root}, not ${copied}, which the file's DEBUG copy comes from`;
}

/**
 * The `INTERNAL` bail of the `each` call a rewrite would have inlined.
 *
 * @param rewrite - The rewrite that failed.
 * @param detail - Why it failed.
 * @returns The bail.
 */
function internalBail(rewrite: EachInlining, detail: string): Bail {
  return { op: "each", pos: rewrite.pos, call: rewrite.call, reason: "INTERNAL", detail };
}

/**
 * Maps the call of every site in `sites`, nested sites included, to its site.
 *
 * @param sites - The sites to index.
 * @param byCall - The map the sites are added to.
 * @returns `byCall`.
 */
function indexSites(sites: readonly Site[], byCall = new Map<NodeID, Site>()): Map<NodeID, Site> {
  for (const site of sites) {
    byCall.set(site.call, site);
    indexSites(site.nested, byCall);
  }
  return byCall;
}

/**
 * The site whose call is `call`.
 *
 * @param byCall - Sites keyed by their call.
 * @param call - The call of a planned rewrite.
 * @returns The site.
 * @throws Error when no site has that call, which a plan of the same sites never yields.
 */
function siteOf(byCall: ReadonlyMap<NodeID, Site>, call: NodeID): Site {
  const site = byCall.get(call);
  if (site === undefined) throw new Error(`no analyzed site has the planned call ${call}`);
  return site;
}

/**
 * The declaration files the shape resolution of `sites` consulted.
 *
 * @param sites - The sites, whose nested sites count too.
 * @returns The files, in site order, with duplicates.
 */
function declarationFiles(sites: readonly Site[]): string[] {
  return sites.flatMap((site) => [...site.declarationFiles, ...declarationFiles(site.nested)]);
}
