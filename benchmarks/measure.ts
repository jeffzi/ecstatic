import type { noInline as bunNoInline } from "bun:jsc";

import { destroyWorld, type World } from "ecstatic";
import {
  Bench,
  type FnOptions,
  type FnReturnedObject,
  type SortedSamples,
  type Task,
} from "tinybench";

import type { Engine } from "./runner.js";

const NS_PER_MS = 1e6;

/** A warmed sample spans at least this many timer steps, so one step is at most 1 % of it. */
const MIN_STEPS_PER_SAMPLE = 100;

/** How many clock transitions the startup probe takes the smallest of. */
const STEP_PROBES = 16;

/** A stopping rule for warmup and the timed run. */
interface Budgets {
  readonly warmupTime: number;
  readonly warmupIterations: number;
  readonly time: number;
  readonly iterations: number;
}

/**
 * A warmed benchmark's stopping rule, tinybench's defaults: each phase runs until both its time,
 * in milliseconds, and its sample count are reached.
 */
const WARMED_BUDGETS: Budgets = {
  warmupTime: 250,
  warmupIterations: 16,
  time: 1000,
  iterations: 64,
};

/**
 * A manual benchmark's stopping rule: fixed sample counts with no time minimum, since every sample
 * builds a world whose cost the clock never sees, and a synchronous run cannot be cut short.
 */
const MANUAL_BUDGETS: Budgets = {
  warmupTime: 0,
  warmupIterations: 1000,
  time: 0,
  iterations: 2000,
};

const TASK_NAME = "body";

/** Runs a whole benchmark (warmup, collection, every timed sample) for a per-sample function. */
type RunBench = (budgets: Budgets, sample: () => FnReturnedObject, hooks: FnOptions) => Measurement;

/** Bun's `noInline` from `bun:jsc`: keeps JavaScriptCore from inlining a function into its callers. */
export type NoInline = typeof bunNoInline;

/**
 * How a benchmark builds its context and what it times.
 *
 * A `warmed` benchmark builds one context, warms the body up on it, times every sample on it, and
 * destroys its world once timing ends, so its body must leave the context as it found it. A
 * `manual` benchmark builds a fresh context for every sample, warmup included, and destroys each
 * sample's world after its one body call, so its body may consume the world freely.
 */
export interface BenchLifecycle<C extends { world: World }> {
  readonly kind: "warmed" | "manual";
  readonly build: () => C;
  readonly body: (ctx: C) => void;
}

/** A benchmark's timed samples, in nanoseconds per body call, and how many there were. */
export interface Measurement {
  readonly min: number;
  readonly p25: number;
  readonly p50: number;
  readonly p75: number;
  readonly p99: number;
  readonly max: number;
  readonly mean: number;
  readonly samples: number;
}

/** What `measure` takes from its engine; each defaults to what the running engine provides. */
export interface MeasureOptions {
  /** Applied to the per-sample function before tinybench sees it; on Node, none is applied. */
  readonly noInline?: NoInline;
}

/**
 * Measures one benchmark with tinybench's synchronous runner.
 *
 * The timer step is measured at startup from `performance.now()` deltas. Warmup runs untimed, then
 * `globalThis.gc()` collects once, then the timed samples run; no build or destroy falls inside a
 * sample's clock reads. A warmed sample times as many consecutive body calls as keep one timer step
 * within 1 % of its span, a count fixed during warmup; a manual sample times one call.
 *
 * @param lifecycle - The benchmark to measure.
 * @param options - Overrides for what the engine provides.
 * @returns The timed samples' statistics, in nanoseconds per body call; every percentile is
 * linearly interpolated from the retained samples.
 * @throws Error when no garbage collector is exposed, before anything runs.
 * @throws Error when Bun is running but `bun:jsc` cannot be loaded, before anything runs.
 * @throws Error when tinybench loses the task, ends the run in a state other than completed, or
 * keeps no samples, or when a manual sample runs without a context.
 * @throws Whatever `build` or `body` throws, unchanged, after the world it built is destroyed.
 */
export async function measure<C extends { world: World }>(
  lifecycle: BenchLifecycle<C>,
  options: MeasureOptions = {},
): Promise<Measurement> {
  const collect = globalThis.gc;
  if (collect === undefined) {
    throw new Error("benchmarks require an exposed gc: run node or bun with --expose-gc");
  }
  const noInline = options.noInline ?? (await engineNoInline());
  const stepMs = timerStepMs();
  const runBench: RunBench = (budgets, sample, hooks) => {
    noInline?.(sample);
    const task = benchTask(budgets, sample, hooks);
    task.warmupSync();
    collect();
    task.runSync();
    return statistics(task);
  };
  return lifecycle.kind === "warmed"
    ? measureWarmed(lifecycle, stepMs, runBench)
    : measureManual(lifecycle, runBench);
}

/**
 * Names the engine this process runs under.
 *
 * @returns "bun" when `process.versions["bun"]` is set, else "node".
 */
export function runningEngine(): Engine {
  return process.versions["bun"] === undefined ? "node" : "bun";
}

/**
 * Loads the running engine's `noInline`, importing `bun:jsc` only under Bun.
 *
 * @returns Bun's `noInline`, or `undefined` on Node, which has none.
 * @throws Error when Bun is running but `bun:jsc` cannot be loaded.
 */
async function engineNoInline(): Promise<NoInline | undefined> {
  if (runningEngine() !== "bun") return undefined;
  const { noInline } = await import("bun:jsc");
  return noInline;
}

/**
 * Measures the timer's step by polling `performance.now()` across `STEP_PROBES` changes of its
 * reading.
 *
 * @returns The smallest change seen, in milliseconds.
 */
function timerStepMs(): number {
  let step = Number.POSITIVE_INFINITY;
  let last = performance.now();
  for (let seen = 0; seen < STEP_PROBES;) {
    const now = performance.now();
    if (now !== last) {
      step = Math.min(step, now - last);
      last = now;
      seen += 1;
    }
  }
  return step;
}

function measureWarmed<C extends { world: World }>(
  { build, body }: BenchLifecycle<C>,
  stepMs: number,
  runBench: RunBench,
): Measurement {
  const ctx = build();
  try {
    let calls = 1;
    let spanMs = 0;
    const sample = (): FnReturnedObject => {
      const started = performance.now();
      for (let call = 0; call < calls; call++) body(ctx);
      spanMs = performance.now() - started;
      return { overriddenDuration: spanMs / calls, overriddenIterationCost: spanMs };
    };
    return runBench(WARMED_BUDGETS, sample, {
      // Warmup settles the batch: once it is fixed, every timed sample runs the same count. A
      // span is a whole number of timer steps; rounding recovers it from the millisecond floats.
      afterEach: (mode) => {
        if (mode === "warmup" && Math.round(spanMs / stepMs) < MIN_STEPS_PER_SAMPLE) calls *= 2;
      },
    });
  } finally {
    destroyWorld(ctx.world);
  }
}

function measureManual<C extends { world: World }>(
  { build, body }: BenchLifecycle<C>,
  runBench: RunBench,
): Measurement {
  let ctx: C | undefined;
  const sample = (): FnReturnedObject => {
    const current = ctx;
    if (current === undefined) throw new Error("a manual sample ran without a context");
    const started = performance.now();
    body(current);
    const spanMs = performance.now() - started;
    return { overriddenDuration: spanMs, overriddenIterationCost: spanMs };
  };
  return runBench(MANUAL_BUDGETS, sample, {
    beforeEach: () => {
      ctx = build();
    },
    // tinybench runs this even when `beforeEach` threw, so a failed build leaves nothing to destroy.
    afterEach: () => {
      const done = ctx;
      ctx = undefined;
      if (done !== undefined) destroyWorld(done.world);
    },
  });
}

/**
 * Adds `sample` to a bench of its own as a synchronous task that keeps its samples.
 *
 * @param budgets - The bench's stopping rule for warmup and the timed run.
 * @param sample - The per-sample function; it reports its own duration.
 * @param hooks - The task's lifecycle hooks.
 * @returns The task, ready for `warmupSync` then `runSync`.
 * @throws Error when tinybench does not return the task it was given.
 */
function benchTask(budgets: Budgets, sample: () => FnReturnedObject, hooks: FnOptions): Task {
  const bench = new Bench({ ...budgets, retainSamples: true, throws: true, warmup: false });
  // Without `async: false`, adding the task calls it once to detect whether it is async.
  bench.add(TASK_NAME, sample, { ...hooks, async: false });
  const task = bench.getTask(TASK_NAME);
  if (task === undefined) throw new Error(`tinybench lost the task "${TASK_NAME}"`);
  return task;
}

/**
 * The statistics of a completed task's retained samples, converted to nanoseconds.
 *
 * @param task - A task whose timed run completed.
 * @returns The samples' extremes, percentiles, mean, and count.
 * @throws Error when the task did not complete or kept no samples.
 */
function statistics(task: Task): Measurement {
  const { result } = task;
  if (result.state !== "completed") throw new Error(`the benchmark ended ${result.state}`);
  const retained: SortedSamples | undefined = result.latency.samples;
  if (retained === undefined) throw new Error("tinybench kept no samples");
  const ns = retained.map((ms) => ms * NS_PER_MS);
  return {
    min: percentile(ns, 0),
    p25: percentile(ns, 0.25),
    p50: percentile(ns, 0.5),
    p75: percentile(ns, 0.75),
    p99: percentile(ns, 0.99),
    max: percentile(ns, 1),
    mean: ns.reduce((sum, value) => sum + value, 0) / ns.length,
    samples: ns.length,
  };
}

/**
 * The `q` quantile of `sorted`, linearly interpolated between its two nearest ranks.
 *
 * @param sorted - Non-empty samples in ascending order.
 * @param q - The quantile, from 0 to 1.
 * @returns The interpolated sample value.
 * @throws Error when `sorted` is empty.
 */
function percentile(sorted: readonly number[], q: number): number {
  const rank = (sorted.length - 1) * q;
  const below = Math.floor(rank);
  const lower = sorted[below];
  const upper = sorted[Math.ceil(rank)];
  if (lower === undefined || upper === undefined) throw new Error("no samples to summarize");
  return lower + (upper - lower) * (rank - below);
}
