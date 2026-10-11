/**
 * Pure logic of the benchmark runner: command-line parsing, the registry of
 * benchmark names, name-to-filter selection, and the shape of the child process
 * each engine is launched with.
 *
 * Nothing here touches the process, the filesystem, or `node:child_process` —
 * that shell lives in `main.ts`. Keeping the decisions separate from the I/O is
 * what makes them testable.
 */

import { bench } from "mitata";

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

/**
 * Outcome of parsing the command line.
 *
 * Parent mode runs the suites matching `filter` (every suite when absent) by
 * spawning one child per benchmark; child mode runs the single named benchmark.
 */
export type ParsedArgs =
  | { mode: "parent"; filter?: string; engines: readonly Engine[] }
  | { mode: "child"; benchName: string };

/**
 * Parse `[<filter>] [--engine node,bun]`, or `--child <name>`.
 *
 * The positional argument is a regex matched against benchmark names and may
 * appear before or after `--engine`; `--child` takes an exact name and
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
 * @returns Parent mode carrying the filter (absent when no positional was given) and the engine
 * list (`["node"]` when `--engine` was absent), or child mode carrying the exact benchmark name.
 * @throws UsageError when the arguments do not fit that grammar.
 */
export function parseArgs(argv: readonly string[]): ParsedArgs {
  const { filter, engines, benchName } = scanArgs(argv);

  if (benchName !== undefined) {
    return childOnly(benchName, filter, engines);
  }

  const parentEngines = engines ?? DEFAULT_ENGINES;
  return filter === undefined
    ? { mode: "parent", engines: parentEngines }
    : { mode: "parent", filter, engines: parentEngines };
}

/** Raw command-line values before mode resolution; every field is absent until its flag or positional is seen. */
interface ScannedArgs {
  filter?: string;
  engines?: readonly Engine[];
  benchName?: string;
}

/**
 * Walk the argument list once, consuming each flag with its value.
 *
 * @param argv - Argument list after the executable and script; read only, never mutated.
 * @returns The filter, engine list, and child benchmark name that appeared, each absent when it did not.
 * @throws UsageError on an unknown flag, a repeated `--engine`, a flag without its value, or a second positional.
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
 * @returns A child-mode result naming `benchName`.
 * @throws UsageError when `filter` or `engines` is present.
 */
function childOnly(
  benchName: string,
  filter: string | undefined,
  engines: readonly Engine[] | undefined,
): ParsedArgs {
  if (filter !== undefined) {
    throw new UsageError("--child takes an exact benchmark name and accepts no filter");
  }
  if (engines !== undefined) {
    throw new UsageError("--child is set by the parent, which picks the engine itself");
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
 * cost an extra process per benchmark.
 *
 * @param engine - Runtime to launch; `bun` is resolved from `PATH` as the bare command `bun`.
 * @param target - `execPath` is the Node binary to run (ignored for bun), `mainPath` the entry
 * script the child executes, `benchName` the exact name handed to `--child`.
 * @returns A fresh spec whose `args` always ends with `<mainPath> --child <benchName>`.
 */
export function childSpawnSpec(
  engine: Engine,
  target: { execPath: string; mainPath: string; benchName: string },
): ChildSpawnSpec {
  const childArgs = [target.mainPath, "--child", target.benchName];
  // Keyed by `Engine`, so adding a variant without a command here is a compile
  // error rather than a runtime hole.
  const byEngine: Record<Engine, ChildSpawnSpec> = {
    node: {
      command: target.execPath,
      args: ["--expose-gc", "--import", "tsx", ...childArgs],
    },
    bun: { command: "bun", args: ["--expose-gc", ...childArgs] },
  };
  return byEngine[engine];
}

// ---------------------------------------------------------------------------
// Benchmark registry and selection
// ---------------------------------------------------------------------------

/**
 * Names registered through `registerBench`, in registration order.
 *
 * A `Set` both rejects duplicates and preserves insertion order. The parent
 * needs this list to know which children to spawn, and mitata cannot supply it:
 * its own trial registry is module-private and `run()` clears it.
 */
const registry = new Set<string>();

/**
 * Register a benchmark with mitata and record its name for the parent runner.
 * Suite files call this instead of mitata's `bench`.
 *
 * @param name - Benchmark name, unique across every suite file; it becomes the mitata alias and
 * the string a parent filter is matched against.
 * @param body - Benchmark body passed to mitata unchanged; typed `unknown` so a generator — what
 * every suite passes, yielding a `TimedYield` or `ManualYield` — is accepted.
 * @throws Error when `name` is already registered — a duplicate would make the
 * parent spawn the same child twice and collide the report aliases.
 */
export function registerBench(name: string, body: () => unknown): void {
  if (registry.has(name)) {
    throw new Error(`duplicate benchmark name '${name}': every benchmark needs its own name`);
  }
  registry.add(name);
  bench(name, body);
}

/**
 * Names registered through `registerBench`.
 *
 * @returns A fresh array in registration order; mutating it does not touch the registry.
 */
export function benchNames(): readonly string[] {
  return [...registry];
}

const REGEX_METACHARACTERS = /[\\^$.*+?()[\]{}|]/g;

/**
 * Build a regex source matching exactly one benchmark name and nothing else.
 *
 * The name is escaped as well as anchored — keep the escape even though
 * current names carry no regex metacharacters: a future name that does must
 * still select only itself.
 *
 * @param name - Benchmark name as registered; taken literally, so any character that is special in a
 * regex is escaped rather than interpreted.
 * @returns Pattern source of the form `^<escaped name>$`, for `new RegExp` with no flags.
 */
export function anchoredFilter(name: string): string {
  return `^${name.replace(REGEX_METACHARACTERS, String.raw`\$&`)}$`;
}

/**
 * Select the benchmarks a parent-mode filter picks out.
 *
 * @param names - Candidate benchmark names, typically `benchNames()`; never mutated.
 * @param filter - Regex source applied unanchored, matching mitata's own `filter.test(name)`
 * semantics: `soa` selects every name containing it. `undefined` selects everything.
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
    const reason = error instanceof Error ? error.message : String(error);
    throw new UsageError(`invalid filter '${filter}': ${reason}`);
  }

  return names.filter((name) => pattern.test(name));
}

// ---------------------------------------------------------------------------
// Child report handling
// ---------------------------------------------------------------------------

/** Thrown when a child's stdout is not a usable mitata report. */
export class ChildReportError extends Error {}

/**
 * One measured run of a benchmark.
 *
 * `error` is the only field the runner itself reads — mitata records a throwing
 * benchmark body there. Everything else (`stats`, `args`, …) is carried through
 * to the merged report untouched.
 */
interface BenchRun {
  readonly error?: unknown;
  readonly [field: string]: unknown;
}

/** One benchmark entry; fields beyond `alias` and `runs` are carried through untouched. */
export interface BenchEntry {
  readonly alias: string;
  readonly runs: readonly BenchRun[];
  readonly [field: string]: unknown;
}

/** A mitata json-format report document. */
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
 * Describe a `runs[].error` for a diagnostic.
 *
 * mitata serializes a thrown error to `{ message, stack }` rather than an Error
 * instance, and a benchmark body may throw a non-Error, so neither a `message`
 * property nor a useful `toString` can be assumed.
 *
 * @param error - The `error` field of a mitata run after its JSON round-trip; any shape.
 * @returns Its `message` when it carries a string one; `a thrown function` or `a thrown symbol`
 * for the two values `JSON.stringify` cannot encode; otherwise `JSON.stringify(error)`.
 */
function describeRunError(error: unknown): string {
  if (isRecord(error) && typeof error["message"] === "string") {
    return error["message"];
  }
  // JSON.stringify returns undefined for these two, which its `string` return
  // type does not admit, so they are ruled out before the call.
  if (typeof error === "function" || typeof error === "symbol") {
    return `a thrown ${typeof error}`;
  }
  return JSON.stringify(error);
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
 * Read the mitata report a child printed to stdout.
 *
 * Validation is structural and shallow: everything the report carries is
 * preserved, because the parent re-serializes it and the comparison tool reads
 * fields — nested `stats`, `args` — that the runner never looks at.
 *
 * @param stdout - Everything the child wrote to stdout; only the slice from the first `{` to the
 * last `}` is parsed, so a stray progress line around the document does not break the run.
 * @returns A report holding exactly one benchmark entry, with `layout` and `context` passed
 * through as the child printed them.
 * @throws ChildReportError when stdout holds no report, the document is
 * malformed, the child ran anything other than exactly one benchmark, or a run
 * recorded an error.
 */
export function parseChildReport(stdout: string): BenchReport {
  const document = parseReportDocument(stdout);
  for (const field of ["layout", "context"]) {
    if (!(field in document)) {
      throw new ChildReportError(`child report has no '${field}' field`);
    }
  }

  const entry = soleBenchmark(document["benchmarks"]);
  for (const run of entry.runs) {
    if (run.error !== null && run.error !== undefined) {
      throw new ChildReportError(
        `benchmark '${entry.alias}' failed: ${describeRunError(run.error)}`,
      );
    }
  }
  return { layout: document["layout"], benchmarks: [entry], context: document["context"] };
}

/**
 * Prefix every benchmark alias with its engine.
 *
 * The parent calls this after `parseChildReport` so that benchmarks from
 * different engines carry distinct aliases before `mergeReports`.
 *
 * @param report - A child's parsed report; not mutated.
 * @param engine - Engine the child ran under; becomes the alias prefix, as in
 * `node/access/get_1field`.
 * @returns A new report whose entries are shallow copies with `alias` rewritten to
 * `<engine>/<alias>`; `layout` and `context` are shared with the input, not copied.
 */
export function namespaceReport(report: BenchReport, engine: Engine): BenchReport {
  const benchmarks = report.benchmarks.map((entry) => ({
    ...entry,
    alias: `${engine}/${entry.alias}`,
  }));
  return { layout: report.layout, benchmarks, context: report.context };
}

/**
 * Fold the children's reports into the single document the parent prints.
 *
 * @param reports - One parsed, namespaced report per child, in the order the children ran; not
 * mutated.
 * @returns A single report whose `benchmarks` concatenates every input's entries in that order.
 * `layout` and `context` come from the first report: the suite declares no mitata groups, so
 * every entry belongs to the same layout collection and the children share one machine.
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
