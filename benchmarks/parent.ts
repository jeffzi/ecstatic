/**
 * Parent mode of the benchmark entry: list the benchmarks, spawn one child per
 * benchmark, and merge the children's reports.
 *
 * `main.ts` imports this module only in parent mode. A benchmark child runs
 * `main.ts` too, and under Bun, module code loaded in a child slows the
 * measured benchmark's timed calls even when none of it runs, and
 * `node:child_process`, which spawning children needs, is such code. Keep
 * everything only the parent needs here, out of the child's module graph.
 */

import { spawn } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { isEnoent } from "../scripts/caught.js";
import {
  type BenchReport,
  benchNames,
  type ChildSpawnSpec,
  childSpawnSpec,
  compileOptimized,
  describeAbnormalExit,
  type Engine,
  FAILURE_EXIT,
  mergeReports,
  namespaceReport,
  parseChildReport,
  selectBenchmarks,
} from "./runner.js";
import { loadAllSuites } from "./suite-loader.js";

/** Gitignored directory the optimized compile writes to; keep it inside the package and outside `node_modules`. */
const OPTIMIZED_OUT_DIR = fileURLToPath(new URL("../.bench-optimized/", import.meta.url));

const BENCHMARK_PROJECT = fileURLToPath(new URL("tsconfig.json", import.meta.url));

/** The child currently measuring, so an interrupt can take it down with us. */
let activeChild: ReturnType<typeof spawn> | undefined;

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
 * Resolve the entry every child runs, compiling the sources first for an optimized run.
 *
 * @param optimized - Whether children run from the optimizer's compiled output.
 * @param mainPath - Path of the source entry, `benchmarks/main.ts`.
 * @returns `mainPath`, or the compiled `benchmarks/main.js` under the output directory.
 * @throws `CompileError` when the optimized compile fails; Error when the compiler process cannot
 * start or exits mid-compile.
 */
async function childEntry(optimized: boolean, mainPath: string): Promise<string> {
  if (!optimized) return mainPath;
  // Loaded here so the compiler stays out of the parent's heap unless a run compiles.
  const { openSession } = await import("../src/plugin/optimizer/session.js");
  const session = await openSession(BENCHMARK_PROJECT);
  try {
    await compileOptimized(session, OPTIMIZED_OUT_DIR);
  } finally {
    await session.close();
  }
  return join(OPTIMIZED_OUT_DIR, "benchmarks", "main.js");
}

/**
 * Forward SIGINT and SIGTERM to the child measuring, then exit with {@link FAILURE_EXIT}, so an
 * interrupted run leaves no child behind.
 */
function forwardInterrupts(): void {
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      activeChild?.kill(signal);
      process.exit(FAILURE_EXIT);
    });
  }
}

/**
 * Spawn one child per selected benchmark and print the merged report.
 *
 * Children run one at a time: concurrent children would contend for cores and
 * measure the contention. The first failure aborts the run rather than spending
 * minutes finishing the remaining children — a failing benchmark is
 * deterministic, and comparison tooling re-invokes this command once per sample.
 *
 * The parent loads every suite to list the benchmarks; each child it spawns
 * loads only its own benchmark's suite and stores that suite's sink. An
 * interrupt from here on is forwarded to the child measuring, and the parent
 * exits with {@link FAILURE_EXIT}.
 *
 * @param engines - Engines to run every selected benchmark under; the outer loop, so one engine's
 * children all finish before the next engine's start.
 * @param optimized - Whether to compile the sources through the optimizer first and run every
 * child from the compiled output, under aliases marked `optimized/`.
 * @param filter - Unanchored regex source selecting benchmarks by name; `undefined` runs every
 * registered benchmark.
 * @param mainPath - Path of the source entry, `benchmarks/main.ts`, which every unoptimized child
 * runs with `--child`.
 * @returns Once the merged report is printed.
 * @throws Error when a suite module fails to load (its own error) or the filter matches no
 * benchmark, both before any child is spawned; `UsageError` on an invalid filter regex;
 * `CompileError` when the optimized compile fails, and Error when its compiler process cannot
 * start or exits mid-compile, both before any child is spawned; `ChildReportError` on an unusable
 * child report; and the spawn or exit error of the first child that fails.
 */
export async function runParent(
  engines: readonly Engine[],
  optimized: boolean,
  filter: string | undefined,
  mainPath: string,
): Promise<void> {
  forwardInterrupts();
  await loadAllSuites();
  const selected = selectBenchmarks(benchNames(), filter);
  if (selected.length === 0) {
    throw new Error(`filter '${String(filter)}' matched no benchmark`);
  }

  const entryPath = await childEntry(optimized, mainPath);
  const reports: BenchReport[] = [];

  for (const engine of engines) {
    for (const benchName of selected) {
      const spec = childSpawnSpec(engine, {
        execPath: process.execPath,
        mainPath: entryPath,
        benchName,
        compiled: optimized,
      });
      const report = parseChildReport(await collectChildReport(spec, engine));
      reports.push(namespaceReport(report, engine, { optimized }));
    }
  }

  process.stdout.write(`${JSON.stringify(mergeReports(reports))}\n`);
}
