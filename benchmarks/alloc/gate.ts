/**
 * Allocation gate: bytes per operation of the hot API on a warm world.
 *
 * Every gated op (`ops.ts`) is measured in its own child process, for
 * the same reason the timing suite spawns one child per benchmark: the ops
 * share library functions, and feedback those functions collect from one op
 * changes what V8 optimizes away for the next. Measured together,
 * an op's bytes/op depended on which ops ran before it; measured alone, the
 * number is a property of the op.
 *
 * In the child, the body first runs `WARMUP_ROUNDS` times so capacity growth,
 * cache fills, and V8's tier-up all land before measurement. Each measured
 * round then forces a collection, reads `heapUsed`, runs the body, reads
 * again; the median delta over `ROUNDS` divided by `DEFAULT_N` is the reported
 * bytes/op. Bodies are steady-state, so no round measures a world the previous
 * round grew.
 *
 * Nothing is timed. The verdicts and budgets live in `budgets.ts`; this file is
 * only the measurement shell. Exit 0 on pass, 1 on any non-`ok` verdict, a
 * failing child, or a child without an exposed `gc`, 2 on a malformed command
 * line.
 *
 * ```
 * npx tsx --expose-gc benchmarks/alloc/gate.ts          # parent: gate every op
 * npx tsx --expose-gc benchmarks/alloc/gate.ts --child <op>   # internal
 * ```
 */

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { errorMessage } from "../../scripts/caught.js";
import { DEFAULT_N } from "../helpers.js";
import {
  childSpawnSpec,
  describeAbnormalExit,
  isDefaultEngines,
  parseArgs,
  UsageError,
} from "../runner.js";
import {
  ALLOC_BUDGETS,
  allocGatePasses,
  EPSILON_BYTES,
  evaluateAlloc,
  formatAllocReport,
} from "./budgets.js";
import { ALLOC_OPS, type OpBuilder } from "./ops.js";

/**
 * Body runs before the first measured round. One run settles capacity growth
 * and cache fills; the rest push the body through V8's tiers, because an
 * interpreted body boxes every double it stores and allocates an iterator per
 * loop — allocations the gate must not attribute to the library.
 */
const WARMUP_ROUNDS = 200;

/**
 * Odd, so the median is a single sample. Generous, because the measuring loop
 * itself settles only after a handful of rounds — its early deltas run a few
 * kilobytes high — and the median must land in the settled tail.
 */
const ROUNDS = 21;
const FAILURE_EXIT = 1;
const USAGE_EXIT = 2;

function median(values: readonly number[]): number {
  const sorted = values.toSorted((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

/**
 * Measure one op's bytes per entity-operation in this process.
 *
 * @param build - Builder for the op; called exactly once, and the world it makes is never
 * destroyed, since the process exits after measuring.
 * @param collect - Forces a full garbage collection; called before every measured round so each
 * delta starts from a settled heap.
 * @returns The median `heapUsed` delta over `ROUNDS` measured rounds divided by `DEFAULT_N`, in
 * bytes; not clamped, so a collection landing mid-body can make it negative.
 */
function measureOp(build: OpBuilder, collect: () => void): number {
  const op = build();
  for (let round = 0; round < WARMUP_ROUNDS; round++) op.body();

  const deltas: number[] = [];
  for (let round = 0; round < ROUNDS; round++) {
    collect();
    const before = process.memoryUsage().heapUsed;
    op.body();
    deltas.push(process.memoryUsage().heapUsed - before);
  }

  return median(deltas) / DEFAULT_N;
}

/**
 * Child mode: measure one op and print its bytes/op as the only stdout line.
 *
 * @param name - Key into `ALLOC_OPS` naming the op to measure.
 * @returns Process exit code: 0 after printing, `FAILURE_EXIT` when no `gc` is exposed or `name`
 * is unknown, with the reason on stderr and nothing on stdout.
 */
function runChild(name: string): number {
  const gc = globalThis.gc;
  if (gc === undefined) {
    console.error(
      "alloc gate requires an exposed gc: run with node --expose-gc (or tsx --expose-gc)",
    );
    return FAILURE_EXIT;
  }
  const build = ALLOC_OPS[name];
  if (build === undefined) {
    console.error(`unknown alloc op '${name}'`);
    return FAILURE_EXIT;
  }
  // The zero-argument call is the synchronous overload; wrapping pins it.
  const collect = (): void => {
    gc();
  };
  process.stdout.write(`${String(measureOp(build, collect))}\n`);
  return 0;
}

/**
 * Read the number a child printed.
 *
 * @param name - Op the child measured; used only in the error message.
 * @param stdout - The child's whole stdout, expected to be one numeric line; trimmed before
 * parsing.
 * @returns The printed value as bytes/op.
 * @throws Error when the trimmed output is not a finite number; an empty stdout is not caught
 * here, since `Number("")` is `0`.
 */
function parseChildValue(name: string, stdout: string): number {
  const value = Number(stdout.trim());
  if (!Number.isFinite(value)) {
    throw new Error(`alloc op '${name}' printed '${stdout.trim()}', not a number`);
  }
  return value;
}

/**
 * Run one op in a fresh child process.
 *
 * The child is always Node with `--expose-gc`; the gate has no engine switch.
 *
 * @param name - Key into `ALLOC_OPS`, passed to the child as `--child <name>`.
 * @param mainPath - Filesystem path of this script, which the child re-executes.
 * @returns The child's bytes/op.
 * @throws Error when the child cannot be spawned (the `spawnSync` error itself), exits with a
 * non-zero status or a signal, or prints something other than a number.
 */
function measureInChild(name: string, mainPath: string): number {
  const spec = childSpawnSpec("node", { execPath: process.execPath, mainPath, benchName: name });
  const child = spawnSync(spec.command, [...spec.args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });
  if (child.error !== undefined) throw child.error;
  if (child.status !== 0) {
    const cause = describeAbnormalExit(child.status, child.signal);
    throw new Error(`alloc op '${name}' failed with ${cause}`);
  }
  return parseChildValue(name, child.stdout);
}

/**
 * Parent mode: one child per op, then the report and the verdict.
 *
 * @returns Process exit code: 0 when every op is `ok`, otherwise `FAILURE_EXIT`; the report
 * reaches stdout either way.
 * @throws Error when any child fails, before the report is printed — the first failure aborts the
 * run.
 */
function runParent(): number {
  const mainPath = fileURLToPath(import.meta.url);
  const measurements: Record<string, number> = {};
  for (const name of Object.keys(ALLOC_OPS)) {
    measurements[name] = measureInChild(name, mainPath);
  }

  const results = evaluateAlloc(measurements, ALLOC_BUDGETS, EPSILON_BYTES);
  process.stdout.write(`${formatAllocReport(results)}\n`);
  return allocGatePasses(results) ? 0 : FAILURE_EXIT;
}

function main(argv: readonly string[]): number {
  const args = parseArgs(argv);
  if (args.mode === "child") return runChild(args.benchName);
  // The shared parser also accepts a filter and engines; the gate has neither.
  if (args.filter !== undefined || !isDefaultEngines(args.engines)) {
    console.error("usage: gate.ts [--child <op>]");
    return USAGE_EXIT;
  }
  return runParent();
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (error) {
  console.error(errorMessage(error));
  process.exitCode = error instanceof UsageError ? USAGE_EXIT : FAILURE_EXIT;
}
