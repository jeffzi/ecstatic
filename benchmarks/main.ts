/**
 * Benchmark entry point: one process per benchmark, one merged report.
 *
 * Run every benchmark in the same process and each one's numbers depend on what
 * ran before it — heap shape, JIT state and GC pressure all carry over, and the
 * spread reached 26x between a benchmark measured alone and the same benchmark
 * measured last. So the parent process measures nothing: it enumerates the
 * registered benchmarks, spawns a fresh child per benchmark, and concatenates
 * the children's reports into the single JSON document it prints. Every
 * benchmark is therefore the first thing its process does.
 *
 * ```
 * main.ts [<filter>] [--engine node|bun] [--optimized]   # parent mode (default)
 * main.ts --child <benchmark-name>                       # child mode (internal)
 * ```
 *
 * `--optimized` first compiles the benchmark sources through the optimizer, in
 * strict mode, into `.bench-optimized/`, then spawns each child from that
 * compiled output. The directory sits inside the package and outside
 * `node_modules`, so the compiled `import "ecstatic"` still resolves to `dist/`
 * through the package's own `exports`.
 *
 * Exit codes: 0 success, 1 runtime failure, 2 malformed command line. Only a
 * successful parent run writes to stdout, so a partial report never reaches a
 * consumer parsing it; diagnostics go to stderr.
 *
 * Under Bun, module code loaded in a child slows the measured benchmark's
 * timed calls even when none of it runs, so before it measures a child loads
 * only this module, the driver, `suite-loader.ts` and its own benchmark's
 * suite. Parent mode's code, which spawns the children, lives in `parent.ts`
 * and is imported only in parent mode; the child reads its CPU model from
 * `node:os` only once it has measured.
 *
 * Importing a suite module registers its benchmarks as a side effect, so this
 * module imports none statically; `suite-loader.ts` loads them. The parent
 * loads every suite to list the benchmarks; a child loads only its own
 * benchmark's suite. Every suite that accumulates results returns them from its
 * `sinkValue`; after measuring, the child stores its own suite's sink in
 * `globalThis.benchSink`, so the results stay reachable and the engine cannot
 * drop the work that made them.
 */

import { fileURLToPath } from "node:url";

import { errorMessage } from "../scripts/caught.js";
import { type Measurement, runningEngine } from "./measure.js";
import {
  type BenchReport,
  type Engine,
  FAILURE_EXIT,
  measureBench,
  parseArgs,
  USAGE_EXIT,
  UsageError,
} from "./runner.js";
import { loadSuite } from "./suite-loader.js";

/** The one layout collection (index 0, no argument types) every entry belongs to. */
const SINGLE_LAYOUT = [{ name: 0, types: [] }];

declare global {
  /** The measured benchmark's suite's sink after a child's measurement; unset until one finishes. */
  var benchSink: number | undefined;
}

// ---------------------------------------------------------------------------
// Child mode
// ---------------------------------------------------------------------------

/** The machine and engine a child measured on, as the report's `context` names them. */
interface RunContext {
  readonly runtime: Engine;
  readonly version: string;
  readonly arch: string;
  readonly cpu: { readonly name: string | undefined };
}

/**
 * Describe what this child measures on, loading `node:os` to read the CPU model.
 *
 * Call it only once the measurement is done: `node:os` loaded before the benchmark runs slows
 * its timed calls under Bun.
 *
 * @returns The running engine and its version, the processor architecture and platform, and the
 * model of the first CPU core, `undefined` when the platform reports none.
 */
async function runContext(): Promise<RunContext> {
  const { cpus } = await import("node:os");
  return {
    runtime: runningEngine(),
    version: process.versions["bun"] ?? process.versions.node,
    arch: `${process.arch}-${process.platform}`,
    cpu: { name: cpus()[0]?.model },
  };
}

/**
 * The report of one measured benchmark.
 *
 * @param benchName - Name the benchmark was registered under; becomes the entry's alias.
 * @param measurement - The benchmark's statistics, in nanoseconds per body call.
 * @returns A report whose one entry holds one run of the statistics, `mean` reported as `avg`,
 * under the single layout collection every child reports, once `runContext` has described the
 * machine.
 */
async function childReport(benchName: string, measurement: Measurement): Promise<BenchReport> {
  const { min, p25, p50, p75, p99, max, mean, samples } = measurement;
  return {
    layout: SINGLE_LAYOUT,
    context: await runContext(),
    benchmarks: [
      {
        alias: benchName,
        runs: [{ stats: { min, p25, p50, p75, p99, max, avg: mean, samples } }],
      },
    ],
  };
}

/**
 * Load the suite `benchName` belongs to and no other, measure exactly that one benchmark, store
 * its suite's sink in `globalThis.benchSink`, then print its report to stdout.
 *
 * A name whose group names no suite loads none, and measures whatever was registered under it
 * beforehand; its stored sink is 0.
 *
 * @param benchName - Exact name of the benchmark to measure; must be in `benchNames()` once its
 * suite is loaded.
 * @returns Once the report is printed and the sink stored.
 * @throws Error when the suite module fails to load (its own error), `benchName` is not
 * registered, no `gc` is exposed, `bun:jsc` cannot be loaded under Bun, or the measurement itself
 * fails (see `measure`'s `@throws`), before anything is printed; whatever the benchmark's build or
 * body throws also propagates, so a failing benchmark exits non-zero rather than printing a report.
 */
async function runChild(benchName: string): Promise<void> {
  const sinkValue = await loadSuite(benchName);
  const measurement = await measureBench(benchName);
  globalThis.benchSink = sinkValue();
  process.stdout.write(`${JSON.stringify(await childReport(benchName, measurement))}\n`);
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

try {
  const args = parseArgs(process.argv.slice(2));
  if (args.mode === "child") {
    await runChild(args.benchName);
  } else {
    const { runParent } = await import("./parent.js");
    await runParent(args.engines, args.optimized, args.filter, fileURLToPath(import.meta.url));
  }
} catch (error) {
  console.error(errorMessage(error));
  process.exitCode = error instanceof UsageError ? USAGE_EXIT : FAILURE_EXIT;
}
