/**
 * Logic of the benchmark runner: command-line parsing, the registry of
 * benchmarks, name-to-filter selection, the shape of the child process each
 * engine is launched with, and the optimized compile.
 *
 * The optimized compile and `measureBench` are the pieces here that do real
 * work: one writes files and drives a compiler, the other runs a benchmark
 * through `measure`. Everything else touches neither the process, the
 * filesystem, nor `node:child_process` — that shell lives in `main.ts`. Keeping
 * the decisions separate from the I/O is what makes them testable.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import type { World } from "ecstatic";

import { errorMessage } from "../scripts/caught.js";
import type { BailDiagnostic, FileBail } from "../src/plugin/optimizer/diagnostics.js";
import type { Bail } from "../src/plugin/optimizer/plan.js";
import type { Session } from "../src/plugin/optimizer/session.js";
import { type BenchLifecycle, measure, type Measurement, type MeasureOptions } from "./measure.js";

// ---------------------------------------------------------------------------
// Engines and argument parsing
// ---------------------------------------------------------------------------

/** Runtime a benchmark child is executed under. */
export type Engine = "node" | "bun";

const ENGINES: ReadonlySet<string> = new Set(["node", "bun"]);

const DEFAULT_ENGINES: readonly Engine[] = ["node"];

function isEngine(value: string): value is Engine {
  return ENGINES.has(value);
}

/**
 * Compare an engine list against the one the parser substitutes when `--engine` is absent.
 *
 * @param engines - Engine list as `parseArgs` produced it; compared by position, not as a set.
 * @returns `true` only when `engines` is `["node"]` — same length, same order; any longer list
 * is not the default even if it contains `node`.
 */
export function isDefaultEngines(engines: readonly Engine[]): boolean {
  return (
    engines.length === DEFAULT_ENGINES.length && DEFAULT_ENGINES.every((e, i) => e === engines[i])
  );
}

/** Thrown for a malformed command line; the caller maps it to exit code 2. */
export class UsageError extends Error {}

const GENERATION_PATTERN = /^[1-9]\d*$/;

// An entity id carries 10 generation bits, so a slot has generations 1 to 1023 and then wraps
// back to 1. Keep this in step with the id layout: the compiled package does not export its own
// bound.
const MAX_GENERATION = 1023;

/**
 * Parse the `BENCH_GENERATION` environment switch.
 *
 * The switch selects the generation every tracked entity id of a benchmark
 * world sits at, so the suite can time ids whose generation bits are set
 * rather than only freshly allocated ones.
 *
 * @param raw - Value of `BENCH_GENERATION` as the environment holds it; `undefined` when unset.
 * @returns The requested generation, or `1` — a world of never-recycled slots — when `raw` is
 * `undefined`.
 * @throws UsageError when `raw` is anything but a base-10 integer from 1 to 1023, the highest
 * generation a slot reaches before it wraps; the empty string, a sign, a fraction, and trailing
 * characters are all rejected.
 */
export function parseGeneration(raw: string | undefined): number {
  if (raw === undefined) {
    return 1;
  }
  if (!GENERATION_PATTERN.test(raw) || Number(raw) > MAX_GENERATION) {
    throw new UsageError(
      `BENCH_GENERATION must be an integer from 1 to ${MAX_GENERATION}, got "${raw}"`,
    );
  }
  return Number(raw);
}

/**
 * Outcome of parsing the command line.
 *
 * Parent mode runs the suites matching `filter` (every suite when absent) by
 * spawning one child per benchmark, from the optimizer's compiled output when
 * `optimized` is set; child mode runs the single named benchmark.
 */
export type ParsedArgs =
  | { mode: "parent"; filter?: string; engines: readonly Engine[]; optimized: boolean }
  | { mode: "child"; benchName: string };

/**
 * Parse `[<filter>] [--engine node,bun] [--optimized]`, or `--child <name>`.
 *
 * The positional argument is a regex matched against benchmark names and may
 * appear before, between, or after the flags; `--child` takes an exact name and
 * combines with nothing else.
 *
 * `--engine` accepts a comma-separated list of engines (e.g. `node,bun`). The
 * flag may appear at most once; a repeated flag is a `UsageError` so a typo
 * cannot silently drop an engine.
 *
 * Known limitation: a filter regex cannot begin with `-`, since it would parse
 * as a flag.
 *
 * @param argv - Argument list after the executable and script, i.e. `process.argv.slice(2)`;
 * read only, never mutated.
 * @returns Parent mode carrying the filter (absent when no positional was given), the engine
 * list (`["node"]` when `--engine` was absent), and whether `--optimized` was given; or child
 * mode carrying the exact benchmark name.
 * @throws UsageError when the arguments do not fit that grammar.
 */
export function parseArgs(argv: readonly string[]): ParsedArgs {
  const { filter, engines, benchName, optimized = false } = scanArgs(argv);

  if (benchName !== undefined) {
    return childOnly(benchName, filter, engines, optimized);
  }

  const parentEngines = engines ?? DEFAULT_ENGINES;
  return filter === undefined
    ? { mode: "parent", engines: parentEngines, optimized }
    : { mode: "parent", filter, engines: parentEngines, optimized };
}

/** Raw command-line values before mode resolution; every field is absent until its flag or positional is seen. */
interface ScannedArgs {
  filter?: string;
  engines?: readonly Engine[];
  benchName?: string;
  optimized?: true;
}

/**
 * Walk the argument list once, consuming each flag with its value.
 *
 * @param argv - Argument list after the executable and script; read only, never mutated.
 * @returns The filter, engine list, child benchmark name, and `--optimized` switch that appeared,
 * each absent when it did not.
 * @throws UsageError on an unknown flag, a repeated `--engine` or `--optimized`, a flag without
 * its value, or a second positional.
 */
function scanArgs(argv: readonly string[]): ScannedArgs {
  const scanned: ScannedArgs = {};

  for (let i = 0; i < argv.length; i += 1) {
    // oxlint-disable-next-line typescript/no-non-null-assertion -- i < argv.length
    const arg = argv[i]!;

    if (arg === "--engine") {
      if (scanned.engines !== undefined) {
        throw new UsageError("--engine may only appear once; list engines comma-separated");
      }
      i += 1;
      scanned.engines = toEngines(flagValue(argv, i, "--engine", "a value: node or bun"));
    } else if (arg === "--optimized") {
      if (scanned.optimized !== undefined) {
        throw new UsageError("--optimized may only appear once");
      }
      scanned.optimized = true;
    } else if (arg === "--child") {
      i += 1;
      scanned.benchName = flagValue(argv, i, "--child", "a benchmark name");
    } else {
      scanned.filter = positional(arg, scanned.filter);
    }
  }

  return scanned;
}

/**
 * Accept `arg` as the single positional filter.
 *
 * @param arg - A non-flag argument; anything starting with `-` is rejected as an unknown flag.
 * @param current - The filter already seen, if any.
 * @returns `arg`, now the filter.
 * @throws UsageError when `arg` looks like a flag or a filter was already given.
 */
function positional(arg: string, current: string | undefined): string {
  if (arg.startsWith("-")) {
    throw new UsageError(`unknown flag '${arg}'`);
  }
  if (current !== undefined) {
    throw new UsageError(`unexpected argument '${arg}': at most one filter is accepted`);
  }
  return arg;
}

/**
 * Read the value a flag consumes from the position after it.
 *
 * @param argv - Full argument list being parsed.
 * @param index - Position of the expected value, i.e. one past the flag; may be past the end.
 * @param flag - Flag text (`--engine`, `--child`) quoted in the error when the value is missing.
 * @param what - Description of the expected value, completing "`<flag>` requires ...".
 * @returns The argument at `index`, verbatim — a value starting with `-` is accepted as-is.
 * @throws UsageError when `index` is past the end of `argv`, naming `flag` and `what`.
 */
function flagValue(argv: readonly string[], index: number, flag: string, what: string): string {
  const value = argv[index];
  if (value === undefined) {
    throw new UsageError(`${flag} requires ${what}`);
  }
  return value;
}

/**
 * Parse the value of `--engine`.
 *
 * @param value - Comma-separated engine names as typed, e.g. `node,bun`; nothing is trimmed, so
 * `node, bun` is rejected as an unknown engine.
 * @returns A fresh array of engines in the order given; never empty, since an empty value is
 * itself an empty item.
 * @throws UsageError on an empty item (a trailing comma included), a name that is not a known
 * engine, or a repeated name.
 */
function toEngines(value: string): readonly Engine[] {
  const items = value.split(",");
  const seen = new Set<string>();
  const engines: Engine[] = [];

  for (const item of items) {
    if (item === "") {
      throw new UsageError(`empty engine name in '${value}': expected ${engineList()}`);
    }
    if (!isEngine(item)) {
      throw new UsageError(`unknown engine '${item}': expected ${engineList()}`);
    }
    if (seen.has(item)) {
      throw new UsageError(`duplicate engine '${item}' in '${value}'`);
    }
    seen.add(item);
    engines.push(item);
  }
  return engines;
}

function engineList(): string {
  return [...ENGINES].join(" or ");
}

/**
 * Build the child-mode result once `--child` was seen.
 *
 * Child mode is the parent's own invocation, so it tolerates no other argument.
 *
 * @param benchName - Exact name given to `--child`; not checked against the registry here.
 * @param filter - Positional filter if one was parsed; must be `undefined`.
 * @param engines - Engine list if `--engine` was parsed; must be `undefined`.
 * @param optimized - Whether `--optimized` was parsed; must be `false`.
 * @returns A child-mode result naming `benchName`.
 * @throws UsageError when `filter`, `engines`, or `optimized` is present.
 */
function childOnly(
  benchName: string,
  filter: string | undefined,
  engines: readonly Engine[] | undefined,
  optimized: boolean,
): ParsedArgs {
  if (filter !== undefined) {
    throw new UsageError("--child takes an exact benchmark name and accepts no filter");
  }
  if (engines !== undefined) {
    throw new UsageError("--child is set by the parent, which picks the engine itself");
  }
  if (optimized) {
    throw new UsageError("--child is set by the parent, which picks the compiled entry itself");
  }
  return { mode: "child", benchName };
}

// ---------------------------------------------------------------------------
// Child process command
// ---------------------------------------------------------------------------

/** Command line for a benchmark child, ready to hand to a process spawner. */
export interface ChildSpawnSpec {
  command: string;
  args: readonly string[];
}

/**
 * Describe why a child process exited abnormally, for an error message.
 *
 * @param code - Exit status as Node reports it: meaningful only when `signal` is `null`, and
 * itself `null` when the process was killed.
 * @param signal - Signal that killed the process, or `null` when it ran to completion and `code`
 * is the reason.
 * @returns `exit code <code>` when the process ran to completion, otherwise `signal <signal>`;
 * the other argument is ignored.
 */
export function describeAbnormalExit(code: number | null, signal: NodeJS.Signals | null): string {
  return signal === null ? `exit code ${String(code)}` : `signal ${signal}`;
}

/**
 * Build the command that runs one benchmark in a fresh child process.
 *
 * Both engines need `--expose-gc`, since the suite refuses to run without a
 * reachable collector. Node is invoked as the binary at `execPath` with
 * `--import tsx` rather than through the `tsx` wrapper, which would re-exec and
 * cost an extra process per benchmark. A compiled entry runs with no loader:
 * tsx would transform the optimizer's output again before it ran.
 *
 * @param engine - Runtime to launch; `bun` is resolved from `PATH` as the bare command `bun`.
 * @param target - `execPath` is the Node binary to run (ignored for bun), `mainPath` the entry
 * script the child executes, `benchName` the exact name handed to `--child`, and `compiled`
 * whether `mainPath` is JavaScript the optimized compile wrote; absent means the TypeScript source.
 * @returns A fresh spec whose `args` always ends with `<mainPath> --child <benchName>`.
 */
export function childSpawnSpec(
  engine: Engine,
  target: { execPath: string; mainPath: string; benchName: string; compiled?: boolean },
): ChildSpawnSpec {
  const childArgs = [target.mainPath, "--child", target.benchName];
  const nodeLoader = target.compiled === true ? [] : ["--import", "tsx"];
  // Keyed by `Engine`, so adding a variant without a command here is a compile
  // error rather than a runtime hole.
  const byEngine: Record<Engine, ChildSpawnSpec> = {
    node: {
      command: target.execPath,
      args: ["--expose-gc", ...nodeLoader, ...childArgs],
    },
    bun: { command: "bun", args: ["--expose-gc", ...childArgs] },
  };
  return byEngine[engine];
}

// ---------------------------------------------------------------------------
// Benchmark registry and selection
// ---------------------------------------------------------------------------

/**
 * Every benchmark registered through `registerBench`, by name, in registration order, each bound
 * to a measurement of its description.
 */
const registry = new Map<string, (options?: MeasureOptions) => Promise<Measurement>>();

/**
 * Register a benchmark under its name, for the parent to spawn and a child to measure.
 *
 * @param name - Benchmark name, unique across every suite file; it becomes the report alias and
 * the string a parent filter is matched against.
 * @param lifecycle - How the benchmark builds its context and what it times, as `warmedBench`
 * or `manualBench` make it; nothing runs until the benchmark is measured.
 * @throws Error when `name` is already registered — a duplicate would make the
 * parent spawn the same child twice and collide the report aliases.
 */
export function registerBench<C extends { world: World }>(
  name: string,
  lifecycle: BenchLifecycle<C>,
): void {
  if (registry.has(name)) {
    throw new Error(`duplicate benchmark name '${name}': every benchmark needs its own name`);
  }
  registry.set(name, (options) => measure(lifecycle, options));
}

/**
 * Names registered through `registerBench`.
 *
 * @returns A fresh array in registration order; mutating it does not touch the registry.
 */
export function benchNames(): readonly string[] {
  return [...registry.keys()];
}

/**
 * Measure the benchmark registered as `name`.
 *
 * @param name - Exact name the benchmark was registered under.
 * @param options - Overrides for what the engine provides, passed to `measure` unchanged.
 * @returns The benchmark's statistics, in nanoseconds per body call.
 * @throws Error (as a rejection) when no benchmark is registered as `name`, naming it, and
 * whatever `measure` rejects with: a missing exposed `gc`, a `bun:jsc` that cannot be loaded under
 * Bun, an internal measurement error (see `measure`'s `@throws`), or what the benchmark's build or
 * body throws.
 */
export function measureBench(name: string, options?: MeasureOptions): Promise<Measurement> {
  const measureRegistered = registry.get(name);
  if (measureRegistered === undefined) {
    return Promise.reject(new Error(`unknown benchmark '${name}'`));
  }
  return measureRegistered(options);
}

/**
 * Select the benchmarks a parent-mode filter picks out.
 *
 * @param names - Candidate benchmark names, typically `benchNames()`; never mutated.
 * @param filter - Regex source tested unanchored against each name: `soa` selects every name
 * containing it. `undefined` selects everything.
 * @returns A fresh array of the selected names in their original order; empty when nothing
 * matched, which the caller decides how to treat.
 * @throws UsageError when `filter` is not a valid regular expression.
 */
export function selectBenchmarks(names: readonly string[], filter?: string): readonly string[] {
  if (filter === undefined) {
    return [...names];
  }

  let pattern: RegExp;
  try {
    pattern = new RegExp(filter);
  } catch (error) {
    const reason = errorMessage(error);
    throw new UsageError(`invalid filter '${filter}': ${reason}`);
  }

  return names.filter((name) => pattern.test(name));
}

// ---------------------------------------------------------------------------
// Child report handling
// ---------------------------------------------------------------------------

/** Thrown when a child's stdout is not a usable report. */
export class ChildReportError extends Error {}

/** One measured run of a benchmark; its fields (`stats`, …) are carried through untouched. */
interface BenchRun {
  readonly [field: string]: unknown;
}

/** One benchmark entry; fields beyond `alias` and `runs` are carried through untouched. */
export interface BenchEntry {
  readonly alias: string;
  readonly runs: readonly BenchRun[];
  readonly [field: string]: unknown;
}

/**
 * A benchmark report document, in the shape the comparison tool reads: `benchmarks[].alias`, and
 * `runs[].stats` in nanoseconds.
 */
export interface BenchReport {
  readonly layout: unknown;
  readonly benchmarks: readonly BenchEntry[];
  readonly context: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isUnknownArray(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

function isBenchEntry(value: unknown): value is BenchEntry {
  return (
    isRecord(value) &&
    typeof value["alias"] === "string" &&
    isUnknownArray(value["runs"]) &&
    value["runs"].every(isRecord)
  );
}

/**
 * Parse the JSON object a child printed, ignoring anything printed around it.
 *
 * @param stdout - Everything the child wrote to stdout; only the slice from the first `{` to the
 * last `}` is parsed.
 * @returns The parsed document as a plain record, unvalidated beyond being a JSON object.
 * @throws ChildReportError when stdout holds no `{...}` span, the span is not valid JSON, or it
 * parses to something other than an object.
 */
function parseReportDocument(stdout: string): Record<string, unknown> {
  const start = stdout.indexOf("{");
  const end = stdout.lastIndexOf("}");
  if (start === -1 || end < start) {
    throw new ChildReportError("child printed no JSON report");
  }

  let document: unknown;
  try {
    document = JSON.parse(stdout.slice(start, end + 1));
  } catch (error) {
    const reason = error instanceof Error ? error.message : "no parse error reported";
    throw new ChildReportError(`child report is not valid JSON: ${reason}`);
  }

  if (!isRecord(document)) {
    throw new ChildReportError("child report is not a JSON object");
  }
  return document;
}

/**
 * Extract the single benchmark a child is expected to have measured.
 *
 * @param benchmarks - The `benchmarks` field of a child's report document, untyped because the
 * document is not validated beyond being an object.
 * @returns The one entry, with every field it carried intact.
 * @throws ChildReportError when the field is not an array, holds any number of entries other
 * than one, or that entry lacks a string `alias` and an array of `runs` objects.
 */
function soleBenchmark(benchmarks: unknown): BenchEntry {
  if (!isUnknownArray(benchmarks)) {
    throw new ChildReportError("child report has no 'benchmarks' array");
  }
  if (benchmarks.length !== 1) {
    throw new ChildReportError(
      `child report holds ${benchmarks.length} benchmarks, expected exactly 1: ` +
        "the child's filter failed to isolate a single benchmark",
    );
  }

  const entry = benchmarks[0];
  if (!isBenchEntry(entry)) {
    throw new ChildReportError("child report has a benchmark without an alias and runs");
  }
  return entry;
}

/**
 * Read the report a child printed to stdout.
 *
 * Validation is structural and shallow: everything the report carries is
 * preserved, because the parent re-serializes it and the comparison tool reads
 * fields — nested `stats` — that the runner never looks at.
 *
 * @param stdout - Everything the child wrote to stdout; only the slice from the first `{` to the
 * last `}` is parsed, so a stray progress line around the document does not break the run.
 * @returns A report holding exactly one benchmark entry, with `layout` and `context` passed
 * through as the child printed them.
 * @throws ChildReportError when stdout holds no report, the document is
 * malformed, or the child ran anything other than exactly one benchmark.
 */
export function parseChildReport(stdout: string): BenchReport {
  const document = parseReportDocument(stdout);
  for (const field of ["layout", "context"]) {
    if (!(field in document)) {
      throw new ChildReportError(`child report has no '${field}' field`);
    }
  }

  const entry = soleBenchmark(document["benchmarks"]);
  return { layout: document["layout"], benchmarks: [entry], context: document["context"] };
}

/**
 * Prefix every benchmark alias with its engine, and mark an optimized run.
 *
 * The parent calls this after `parseChildReport` so that benchmarks from
 * different engines, and plain and optimized runs, carry distinct aliases
 * before `mergeReports`.
 *
 * @param report - A child's parsed report; not mutated.
 * @param engine - Engine the child ran under; becomes the alias prefix, as in
 * `node/access/get_1field`.
 * @param variant - `optimized` is whether the child ran the optimizer's compiled output; plain
 * when omitted.
 * @returns A new report whose entries are shallow copies with `alias` rewritten to
 * `<engine>/<alias>`, or `<engine>/optimized/<alias>` for an optimized run; `layout` and
 * `context` are shared with the input, not copied.
 */
export function namespaceReport(
  report: BenchReport,
  engine: Engine,
  variant: { optimized: boolean } = { optimized: false },
): BenchReport {
  const prefix = variant.optimized ? `${engine}/optimized/` : `${engine}/`;
  const benchmarks = report.benchmarks.map((entry) => ({
    ...entry,
    alias: `${prefix}${entry.alias}`,
  }));
  return { layout: report.layout, benchmarks, context: report.context };
}

/**
 * Fold the children's reports into the single document the parent prints.
 *
 * @param reports - One parsed, namespaced report per child, in the order the children ran; not
 * mutated.
 * @returns A single report whose `benchmarks` concatenates every input's entries in that order.
 * `layout` and `context` come from the first report: every child reports the same single
 * layout collection, and the children share one machine.
 * @throws ChildReportError when there is nothing to merge, or when two reports
 * carry the same alias — the comparison tool silently keeps the last of a
 * collision.
 */
export function mergeReports(reports: readonly BenchReport[]): BenchReport {
  const first = reports[0];
  if (first === undefined) {
    throw new ChildReportError("no child reports to merge");
  }

  const benchmarks: BenchEntry[] = [];
  const aliases = new Set<string>();
  for (const report of reports) {
    for (const entry of report.benchmarks) {
      if (aliases.has(entry.alias)) {
        throw new ChildReportError(
          `duplicate benchmark alias '${entry.alias}': the merged report would lose one of them`,
        );
      }
      aliases.add(entry.alias);
      benchmarks.push(entry);
    }
  }

  return { layout: first.layout, benchmarks, context: first.context };
}

// ---------------------------------------------------------------------------
// Optimized compile
// ---------------------------------------------------------------------------

/** Thrown when the optimized compile fails; the message carries the cause. */
export class CompileError extends Error {}

/** The repository root, whose layout the compiled tree mirrors under its output directory. */
const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

const DECLARATION_FILE = /\.d\.[cm]?ts$/u;

/** A TypeScript source extension; the capture keeps a module's `c` or `m` marker for the output's. */
const SOURCE_EXTENSION = /\.([cm]?)tsx?$/u;

/** The optimized compile fails on any bail the optimizer would report under strict. */
const STRICT = true;

/**
 * Compile the project `session` loaded through the optimizer, in strict mode, and write the
 * JavaScript under `outDir`.
 *
 * Every source in the project's directory is rewritten; the program's other sources, such as the
 * modules the benchmarks import from `scripts/`, are emitted as they are. Each output lands at its
 * source's path relative to the repository root, its extension `.js`. Package imports such as
 * `"ecstatic"` are emitted as written.
 *
 * The optimizer modules load on the first call, so a benchmark child, which imports this module
 * but never compiles, keeps them out of the heap it measures.
 *
 * @param session - Session on the project to compile; it serves the rewritten texts from here on.
 * @param outDir - Directory the JavaScript is written under.
 * @returns Once every output is written.
 * @throws CompileError (as a rejection) when the program has a TypeScript error, the optimizer
 * reports a diagnostic, a source lies outside the repository, or an output cannot be written; the
 * message carries the errors, or the path and the cause.
 * @throws Error (as a rejection) when the session is closed or its compiler process exited.
 */
export async function compileOptimized(session: Session, outDir: string): Promise<void> {
  const [{ createRewriter }, { bailDiagnostics }] = await Promise.all([
    import("../src/plugin/optimizer/rewrite.js"),
    import("../src/plugin/optimizer/diagnostics.js"),
  ]);
  const failed = `optimized compile of ${session.tsconfig} failed`;

  const view = await session.update();
  const errors = await view.errors();
  if (errors !== "") {
    throw new CompileError(`${failed}:\n${errors}`);
  }

  const sources = (await view.sourceFileNames()).filter((file) => !DECLARATION_FILE.test(file));
  const projectDir = dirname(session.tsconfig);
  const rewriter = createRewriter(session);
  const rewritten: Record<string, string> = {};
  const bails: (Bail | FileBail)[] = [];
  for (const file of sources.filter((source) => isInside(projectDir, source))) {
    const module = await rewriter.rewrite(view, file);
    bails.push(...module.bails);
    if (module.fileBail !== undefined) bails.push(module.fileBail);
    if (module.output !== undefined) rewritten[file] = module.output.text;
  }
  const diagnostics = bailDiagnostics(bails, STRICT);
  if (diagnostics.length > 0) {
    throw new CompileError(`${failed}:\n${diagnostics.map(locatedMessage).join("\n")}`);
  }

  const optimized = await session.update(rewritten);
  for (const file of sources) {
    if (!isInside(REPO_ROOT, file)) {
      throw new CompileError(`${failed}: ${file} lies outside ${REPO_ROOT}`);
    }
    const output = join(outDir, relative(REPO_ROOT, file).replace(SOURCE_EXTENSION, ".$1js"));
    writeOutput(output, await optimized.emit(file));
  }
}

/**
 * Tell whether a path lies below a directory.
 *
 * @param dir - Absolute path of the directory.
 * @param file - Absolute path to place.
 * @returns Whether `file` lies below `dir`, `dir` itself excluded.
 */
function isInside(dir: string, file: string): boolean {
  const path = relative(dir, file);
  return path !== "" && !path.startsWith("..") && !isAbsolute(path);
}

/**
 * Word one optimizer diagnostic with its location.
 *
 * @param diagnostic - The diagnostic to word.
 * @returns The diagnostic's message, prefixed with its `file:line:column`.
 */
function locatedMessage(diagnostic: BailDiagnostic): string {
  const { file, line, column, message } = diagnostic;
  return `${file}:${String(line)}:${String(column)}: ${message}`;
}

/**
 * Write one compiled output, creating its directory first.
 *
 * @param file - Absolute path of the output.
 * @param text - JavaScript to write.
 * @throws CompileError naming `file` and the filesystem's error when either write fails.
 */
function writeOutput(file: string, text: string): void {
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text);
  } catch (error) {
    throw new CompileError(`cannot write ${file}: ${errorMessage(error)}`, { cause: error });
  }
}
