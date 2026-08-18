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

/** Runtime a benchmark child is executed under. */
export type Engine = "node" | "bun";

const ENGINES: ReadonlySet<string> = new Set(["node", "bun"]);

const DEFAULT_ENGINES: readonly Engine[] = ["node"];

function isEngine(value: string): value is Engine {
  return ENGINES.has(value);
}

/** True when `engines` is exactly the default list (`["node"]`). */
export function isDefaultEngines(engines: readonly Engine[]): boolean {
  return engines.length === 1 && engines[0] === "node";
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
 * `argv` is the argument list after the executable and script, i.e.
 * `process.argv.slice(2)`. The positional argument is a regex matched against
 * benchmark names and may appear before or after `--engine`; `--child` takes an
 * exact name and combines with nothing else.
 *
 * `--engine` accepts a comma-separated list of engines (e.g. `node,bun`). The
 * flag may appear at most once; a repeated flag is a `UsageError` so a typo
 * cannot silently drop an engine.
 *
 * Known limitation: a filter regex cannot begin with `-`, since it would parse
 * as a flag.
 *
 * @throws UsageError when the arguments do not fit that grammar.
 */
export function parseArgs(argv: readonly string[]): ParsedArgs {
  let filter: string | undefined;
  let engines: readonly Engine[] | undefined;
  let benchName: string | undefined;

  for (let i = 0; i < argv.length; i += 1) {
    // oxlint-disable-next-line typescript/no-non-null-assertion -- i < argv.length
    const arg = argv[i]!;

    if (arg === "--engine") {
      if (engines !== undefined) {
        throw new UsageError("--engine may only appear once; list engines comma-separated");
      }
      i += 1;
      engines = toEngines(flagValue(argv, i, "--engine", "a value: node or bun"));
    } else if (arg === "--child") {
      i += 1;
      benchName = flagValue(argv, i, "--child", "a benchmark name");
    } else if (arg.startsWith("-")) {
      throw new UsageError(`unknown flag '${arg}'`);
    } else if (filter !== undefined) {
      throw new UsageError(`unexpected argument '${arg}': at most one filter is accepted`);
    } else {
      filter = arg;
    }
  }

  if (benchName !== undefined) {
    return childOnly(benchName, filter, engines);
  }

  const parentEngines = engines ?? DEFAULT_ENGINES;
  return filter === undefined
    ? { mode: "parent", engines: parentEngines }
    : { mode: "parent", filter, engines: parentEngines };
}

/** The argument at `index`, or a UsageError naming what `flag` expected. */
function flagValue(argv: readonly string[], index: number, flag: string, what: string): string {
  const value = argv[index];
  if (value === undefined) {
    throw new UsageError(`${flag} requires ${what}`);
  }
  return value;
}

/** Parse a comma-separated engine list, rejecting empty items, unknowns, and duplicates. */
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

/** Child mode is the parent's own invocation, so it tolerates no other argument. */
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

/** Command line for a benchmark child, ready to hand to a process spawner. */
export interface ChildSpawnSpec {
  command: string;
  args: readonly string[];
}

/**
 * Describe why a child process exited abnormally, for an error message.
 *
 * A `null` signal means the process ran to completion and reports its exit
 * code; a non-null signal means it was killed and the code is meaningless.
 */
export function describeAbnormalExit(code: number | null, signal: NodeJS.Signals | null): string {
  return signal === null ? `exit code ${String(code)}` : `signal ${signal}`;
}

/**
 * Build the command that runs `benchName` in a fresh child process.
 *
 * Both engines need `--expose-gc`, since the suite refuses to run without a
 * reachable collector. Node is invoked as the binary at `execPath` with
 * `--import tsx` rather than through the `tsx` wrapper, which would re-exec and
 * cost an extra process per benchmark.
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

/**
 * Names registered through `registerBench`, in registration order.
 *
 * A `Set` both rejects duplicates and preserves insertion order. The parent
 * needs this list to know which children to spawn, and mitata cannot supply it:
 * its own trial registry is module-private and `run()` clears it.
 */
const registry = new Set<string>();

/**
 * Register `body` with mitata under `name` and record the name for the parent
 * runner. Suite files call this instead of mitata's `bench`.
 *
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

/** Registered benchmark names, in registration order. */
export function benchNames(): readonly string[] {
  return [...registry];
}

const REGEX_METACHARACTERS = /[\\^$.*+?()[\]{}|]/g;

/**
 * A regex source matching exactly `name` and nothing else.
 *
 * Benchmark names contain `.`, so the name is escaped as well as anchored:
 * unescaped, the filter for `access.get_1field` would also match
 * `access:get_1field`.
 */
export function anchoredFilter(name: string): string {
  return `^${name.replace(REGEX_METACHARACTERS, String.raw`\$&`)}$`;
}

/**
 * The subset of `names` a parent-mode filter selects, in the original order.
 *
 * The filter is unanchored, matching mitata's own `filter.test(name)`
 * semantics: `soa` selects every name containing it. An absent filter selects
 * everything.
 *
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

/** Parse the JSON object a child printed, ignoring anything printed around it. */
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

/** The single benchmark a child is expected to have measured. */
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
 * Only the slice from the first `{` to the last `}` is parsed, so a stray
 * progress line around the document does not break the run. Validation is
 * structural and shallow: everything the report carries is preserved, because
 * the parent re-serializes it and the comparison tool reads fields — nested
 * `stats`, `args` — that the runner never looks at.
 *
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
 * Prefix every benchmark alias in `report` with `engine/`, producing a new
 * report without mutating the input.
 *
 * The parent calls this after `parseChildReport` so that benchmarks from
 * different engines carry distinct aliases before `mergeReports`.
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
 * `layout` and `context` come from the first report: the suite declares no
 * mitata groups, so every entry belongs to the same layout collection and the
 * children share one machine.
 *
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
