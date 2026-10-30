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

/**
 * Every sample, warmed or manual, spans at least this many timer steps once warmup settles its
 * count, so one step is at most 0.5 % of it. A warmup sample that falls short scales its count by
 * how far short it fell, so the count lands near the smallest one that reaches this span: any count
 * past that lengthens the run for no gain in resolution, and a manual sample builds and destroys a
 * world for each of its calls.
 */
const MIN_STEPS_PER_SAMPLE = 200;

/**
 * How much a warmup sample that read no timer step multiplies its count by: a zero span gives no
 * ratio to scale by, so the count grows by a fixed factor large enough to reach a measurable span
 * in few samples.
 */
const ZERO_STEP_GROWTH = 100;

/**
 * Past this many calls per sample, a warmed body is too short for the timer: the cap turns it into
 * an error instead of a batch that grows without bound.
 */
const WARMED_CAP = 1_000_000;

/**
 * Past this many calls per sample, a manual body is too short for the timer: every call builds and
 * destroys a world outside the clock reads, so the cap bounds how long a sample's untimed setup
 * runs and fails the run instead.
 */
const MANUAL_CAP = 64;

/**
 * How many clock transitions the startup probe takes the smallest of.
 *
 * A read of the clock plus the loop around it takes about as long as a step, so most transitions
 * the probe sees span two or three steps. Sixteen of them often never include a single-step one,
 * and the probe then overstates the step by two to four times, inflating every batch; two thousand
 * find it every time, for about 0.2 ms of startup.
 */
const STEP_PROBES = 2000;

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
 * A manual benchmark's stopping rule: fixed sample counts with no time minimum, since every call
 * builds a world whose cost the clock never sees, and a synchronous run cannot be cut short. The
 * counts are samples, not body calls, so a sample's call count leaves them unchanged.
 */
const MANUAL_BUDGETS: Budgets = {
  warmupTime: 0,
  warmupIterations: 1000,
  time: 0,
  iterations: 2000,
};

const TASK_NAME = "body";

/**
 * Runs a whole benchmark (warmup, collection, every timed sample) for a per-sample function and
 * returns its completed task.
 */
type RunBench = (budgets: Budgets, sample: () => FnReturnedObject, hooks: FnOptions) => Task;

/** Bun's `noInline` from `bun:jsc`: keeps JavaScriptCore from inlining a function into its callers. */
export type NoInline = typeof bunNoInline;

/**
 * How a benchmark builds its context and what it times.
 *
 * A `warmed` benchmark builds one context, warms the body up on it, times every sample on it, and
 * destroys its world once timing ends, so its body must leave the context as it found it. A
 * `manual` benchmark builds a fresh context for every body call, warmup included, runs the body
 * once on it, and destroys its world right after that call, before building the next, so its body
 * may consume the world freely.
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
 * The driver times every sample itself, reading `performance.now()` around the sample's body calls,
 * and hands tinybench the span as the sample's duration, so tinybench's own clock never changes a
 * figure, and warmup and timed samples are measured the same way. The timer step is measured at
 * startup from `performance.now()`'s deltas. Warmup runs, then `globalThis.gc()` collects once, then
 * the timed samples run; no build or destroy falls inside a pair of clock reads. A sample's count
 * starts at 1, and every warmup sample that spans fewer than `MIN_STEPS_PER_SAMPLE` timer steps
 * grows it in proportion to how far short it fell (by `ZERO_STEP_GROWTH` when it read no step);
 * every timed sample runs the count warmup settled on. A warmed sample runs that many consecutive
 * body calls on its one context between one pair of clock reads. A manual sample runs that many
 * calls one world at a time: for each it builds a world, reads the clock, runs the body once,
 * reads the clock, and destroys the world, and its span is the sum of those per-call spans. Every
 * statistic is a sample's span divided by its count.
 *
 * @param lifecycle - The benchmark to measure.
 * @param options - Overrides for what the engine provides.
 * @returns The timed samples' statistics, in nanoseconds per body call; every percentile is
 * linearly interpolated from the retained samples.
 * @throws Error when no garbage collector is exposed, before anything runs.
 * @throws Error when Bun is running but `bun:jsc` cannot be loaded, before anything runs.
 * @throws Error when tinybench loses the task, ends the run in a state other than completed, or
 * keeps no samples.
 * @throws Error when warmup asks for more calls per warmed sample than `WARMED_CAP` allows, or more
 * calls per manual sample than `MANUAL_CAP` allows, naming the count it asked for: the body is too
 * short to time at that cap. No sample runs that count, and no world is built for it.
 * @throws Whatever `build` or `body` throws, once every world built so far is destroyed: a warmed
 * benchmark's one world, or every world a manual benchmark built, each destroyed right after its own
 * body call, the failing call's included when its `build` returned. An `Error` propagates
 * unchanged, and so does any value a warmed benchmark's `build` throws, since it runs before
 * tinybench does; tinybench wraps any other non-`Error` value in a new `Error`.
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
    return task;
  };
  return lifecycle.kind === "warmed"
    ? measureWarmed(lifecycle, stepMs, runBench)
    : measureManual(lifecycle, stepMs, runBench);
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

/**
 * What a sampler shares with its `afterEach` hook: the calls per sample, and the span of the sample
 * that just ended, which is `undefined` until a sample records one.
 */
interface Pacing {
  calls: number;
  spanMs: number | undefined;
}

// Both samplers below: every sample, warmup or timed, reads the clock the same way and reports its
// span through `reportedSample`; `settlingHooks` settles the count from a warmup sample's span alone.
function measureWarmed<C extends { world: World }>(
  { build, body }: BenchLifecycle<C>,
  stepMs: number,
  runBench: RunBench,
): Measurement {
  const ctx = build();
  try {
    const pacing: Pacing = { calls: 1, spanMs: undefined };
    const sample = (): FnReturnedObject => {
      const started = performance.now();
      for (let call = 0; call < pacing.calls; call++) body(ctx);
      pacing.spanMs = performance.now() - started;
      return reportedSample(pacing.spanMs, pacing.calls);
    };
    const task = runBench(WARMED_BUDGETS, sample, settlingHooks(pacing, stepMs, WARMED_CAP));
    return statistics(task);
  } finally {
    destroyWorld(ctx.world);
  }
}

function measureManual<C extends { world: World }>(
  { build, body }: BenchLifecycle<C>,
  stepMs: number,
  runBench: RunBench,
): Measurement {
  const pacing: Pacing = { calls: 1, spanMs: undefined };
  const sample = (): FnReturnedObject => {
    let summedMs = 0;
    for (let call = 0; call < pacing.calls; call++) {
      const ctx = build();
      try {
        const started = performance.now();
        body(ctx);
        summedMs += performance.now() - started;
      } finally {
        destroyWorld(ctx.world);
      }
    }
    pacing.spanMs = summedMs;
    return reportedSample(summedMs, pacing.calls);
  };
  const task = runBench(MANUAL_BUDGETS, sample, settlingHooks(pacing, stepMs, MANUAL_CAP));
  return statistics(task);
}

function settlingHooks(pacing: Pacing, stepMs: number, cap: number): FnOptions {
  return {
    afterEach: (mode) => {
      const warmupSpanMs = mode === "warmup" ? pacing.spanMs : undefined;
      pacing.spanMs = undefined;
      pacing.calls = settledCount(pacing.calls, warmupSpanMs, stepMs, cap);
    },
  };
}

/**
 * The value a sample function returns so tinybench records the driver's span instead of timing the
 * call itself.
 *
 * @param spanMs - The sample's span, in milliseconds.
 * @param count - The body calls the sample ran.
 * @returns tinybench's overridden-duration object: the per-call duration as the sample, and the
 * whole span as what the sample cost against the time budget.
 */
function reportedSample(spanMs: number, count: number): FnReturnedObject {
  return { overriddenDuration: spanMs / count, overriddenIterationCost: spanMs };
}

/**
 * The count the next sample runs, settled during warmup and fixed once timing begins, so every
 * timed sample runs the same count.
 *
 * Each warmup sample decides on its own span alone, so a later short sample grows the count again
 * even after an earlier one reached `MIN_STEPS_PER_SAMPLE` steps.
 *
 * @param count - The count the sample that just ended ran.
 * @param spanMs - That sample's span, in milliseconds, passed only for a warmup sample; `undefined`
 * for a timed sample, so timing never changes the count, and for a warmup sample that threw before
 * its span was summed, so the cap never masks its error.
 * @param stepMs - The timer's step, in milliseconds.
 * @param cap - The most calls per sample the driver may run.
 * @returns `ceil(count × MIN_STEPS_PER_SAMPLE / steps)` when the sample spanned `steps` timer steps,
 * fewer than `MIN_STEPS_PER_SAMPLE`; `count × ZERO_STEP_GROWTH` when it read no step; else `count`
 * unchanged.
 * @throws Error when the grown count exceeds `cap`, naming the count asked for.
 */
function settledCount(
  count: number,
  spanMs: number | undefined,
  stepMs: number,
  cap: number,
): number {
  if (spanMs === undefined) return count;
  // A span is a whole number of timer steps; rounding recovers it from the millisecond floats.
  const steps = Math.round(spanMs / stepMs);
  if (steps >= MIN_STEPS_PER_SAMPLE) return count;
  const grown =
    steps === 0 ? count * ZERO_STEP_GROWTH : Math.ceil((count * MIN_STEPS_PER_SAMPLE) / steps);
  if (grown > cap) {
    throw new Error(
      `warmup asked for ${grown} calls per sample: the body is too short to time at the cap of ${cap} calls`,
    );
  }
  return grown;
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
 * The statistics of a completed task's retained samples, each already per body call, in
 * nanoseconds.
 *
 * @param task - A task whose timed run completed.
 * @returns The samples' extremes, percentiles, and mean, and how many samples there were.
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
