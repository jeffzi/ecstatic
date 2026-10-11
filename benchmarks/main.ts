/**
 * Benchmark entry point: one process per benchmark, one merged report.
 *
 * Run every benchmark in the same process and each one's numbers depend on what
 * ran before it — heap shape, JIT state and GC pressure all carry over, and the
 * spread reached 26x between a benchmark measured alone and the same benchmark
 * measured last. So the parent process measures nothing: it enumerates the
 * registered benchmarks, spawns a fresh child per benchmark, and concatenates
 * the children's mitata reports into the single JSON document it prints. Every
 * benchmark is therefore the first thing its process does.
 *
 * ```
 * main.ts [<filter>] [--engine node|bun]   # parent mode (default)
 * main.ts --child <benchmark-name>         # child mode (internal)
 * ```
 *
 * Exit codes: 0 success, 1 runtime failure, 2 malformed command line. Only a
 * successful parent run writes to stdout, so a partial report never reaches a
 * consumer parsing it; diagnostics go to stderr.
 *
 * Importing a suite module registers its benchmarks as a side effect; the
 * `sinkValue` imports exist so the accumulated results stay reachable until
 * after `run` returns.
 */

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { do_not_optimize, run } from "mitata";

import { sinkValue as accessSink } from "./access-bench.js";
import { sinkValue as entitySink } from "./entity-bench.js";
import { sinkValue as iterationSink } from "./iteration-bench.js";
import { sinkValue as manySink } from "./many-bench.js";
import {
  anchoredFilter,
  type BenchReport,
  benchNames,
  type ChildSpawnSpec,
  childSpawnSpec,
  describeAbnormalExit,
  type Engine,
  mergeReports,
  namespaceReport,
  parseArgs,
  parseChildReport,
  selectBenchmarks,
  UsageError,
} from "./runner.js";

const FAILURE_EXIT = 1;
const USAGE_EXIT = 2;

// ---------------------------------------------------------------------------
// Child mode
// ---------------------------------------------------------------------------

/**
 * Measure exactly one benchmark and print its mitata report to stdout.
 *
 * `throw: true` makes a failing benchmark body crash this child; mitata's
 * default records the exception in `runs[].error` and still exits 0, which would
 * hand the parent a report full of missing numbers that looks successful.
 *
 * @param benchName - Exact name of the benchmark to measure; must be in `benchNames()`.
 * @throws Error when `benchName` is not registered or no `gc` is exposed; a throwing benchmark
 * body also propagates, by way of `throw: true`.
 */
async function runChild(benchName: string): Promise<void> {
  if (!benchNames().includes(benchName)) {
    throw new Error(`unknown benchmark '${benchName}'`);
  }

  // Without an exposed gc, mitata substitutes a fallback that allocates a 1 GiB
  // buffer once per benchmark to force a collection, and drops its gc
  // accounting. That perturbs the timings rather than merely omitting a
  // statistic, so refuse to produce numbers that would silently not be
  // comparable.
  if (globalThis.gc === undefined) {
    throw new Error("benchmarks require an exposed gc: run node or bun with --expose-gc");
  }

  await run({
    format: { json: { debug: false, samples: false } },
    filter: new RegExp(anchoredFilter(benchName)),
    throw: true,
  });

  do_not_optimize(accessSink() + entitySink() + iterationSink() + manySink());
}

// ---------------------------------------------------------------------------
// Parent mode
// ---------------------------------------------------------------------------

/** The child currently measuring, so an interrupt can take it down with us. */
let activeChild: ReturnType<typeof spawn> | undefined;

function isEnoent(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

/**
 * Run one child to completion.
 *
 * @param spec - Command and arguments to spawn, as `childSpawnSpec` builds them; `args` is copied
 * before spawning.
 * @param engine - Engine the spec targets; used only to turn a missing `bun` binary into a
 * readable error.
 * @returns Everything the child wrote to stdout, decoded as UTF-8, once it exits with status 0.
 * @throws Error (as a rejection) when the child cannot be spawned — `bun not found` for a missing
 * bun binary, the raw spawn error otherwise — or exits with a non-zero status or a signal, naming
 * the command and the cause.
 */
function collectChildReport(spec: ChildSpawnSpec, engine: Engine): Promise<string> {
  return new Promise((resolve, reject) => {
    // stdout is captured because it carries the report; stderr is inherited so
    // the child's own diagnostics reach the operator as they happen.
    const child = spawn(spec.command, [...spec.args], { stdio: ["ignore", "pipe", "inherit"] });
    activeChild = child;

    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });

    child.on("error", (error) => {
      activeChild = undefined;
      if (engine === "bun" && isEnoent(error)) {
        reject(new Error("bun not found; install bun or use --engine node"));
        return;
      }
      reject(error);
    });

    child.on("close", (code, signal) => {
      activeChild = undefined;
      if (code === 0) {
        resolve(stdout);
        return;
      }
      const cause = describeAbnormalExit(code, signal);
      reject(new Error(`${spec.command} ${spec.args.join(" ")} failed with ${cause}`));
    });
  });
}

/**
 * Spawn one child per selected benchmark and print the merged report.
 *
 * Children run one at a time: concurrent children would contend for cores and
 * measure the contention. The first failure aborts the run rather than spending
 * minutes finishing the remaining children — a failing benchmark is
 * deterministic, and comparison tooling re-invokes this command once per sample.
 *
 * @param engines - Engines to run every selected benchmark under; the outer loop, so one engine's
 * children all finish before the next engine's start.
 * @param filter - Unanchored regex source selecting benchmarks by name; `undefined` runs every
 * registered benchmark.
 * @throws Error when the filter matches no benchmark; `UsageError` on an invalid filter regex;
 * `ChildReportError` on an unusable child report; and the spawn or exit error of the first child
 * that fails.
 */
async function runParent(engines: readonly Engine[], filter?: string): Promise<void> {
  const selected = selectBenchmarks(benchNames(), filter);
  if (selected.length === 0) {
    throw new Error(`filter '${String(filter)}' matched no benchmark`);
  }

  const mainPath = fileURLToPath(import.meta.url);
  const reports: BenchReport[] = [];

  for (const engine of engines) {
    for (const benchName of selected) {
      const spec = childSpawnSpec(engine, { execPath: process.execPath, mainPath, benchName });
      const report = parseChildReport(await collectChildReport(spec, engine));
      reports.push(namespaceReport(report, engine));
    }
  }

  process.stdout.write(`${JSON.stringify(mergeReports(reports))}\n`);
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    activeChild?.kill(signal);
    process.exit(FAILURE_EXIT);
  });
}

try {
  const args = parseArgs(process.argv.slice(2));
  if (args.mode === "child") {
    await runChild(args.benchName);
  } else {
    await runParent(args.engines, args.filter);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = error instanceof UsageError ? USAGE_EXIT : FAILURE_EXIT;
}
