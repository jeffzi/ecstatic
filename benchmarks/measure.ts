import type { noInline as bunNoInline } from "bun:jsc";

import { destroyWorld, type World } from "ecstatic";
import {
  Bench,
  type FnOptions,
  type SortedSamples,
  type Task,
  type TimestampProvider,
  type TimestampValue,
} from "tinybench";

import type { Engine } from "./runner.js";

const NS_PER_MS = 1e6;

/**
 * Every sample, warmed or manual, spans at least this many timer steps once warmup settles its
 * count, so one step is at most 0.5 % of it. A warmup sample that falls short scales its count by
 * how far short it fell, so the count lands near the smallest one that reaches this span: a manual
 * sample keeps that many worlds alive at once, and any count past that holds more memory for no
 * gain in resolution.
 */
const MIN_STEPS_PER_SAMPLE = 200;

/**
 * How much a warmup sample that read no timer step multiplies its count by: a zero span gives no
 * ratio to scale by, so the count grows by a fixed factor large enough to reach a measurable span
 * in few samples.
 */
const ZERO_STEP_GROWTH = 100;

/** The most calls a warmed sample may run, or contexts a manual sample may build. */
interface CountCap {
  readonly limit: number;
  readonly unit: "calls" | "contexts";
}

/**
 * Past this many calls per sample, a warmed body is too short for the timer: the cap turns it into
 * an error instead of a batch that grows without bound.
 */
const WARMED_CAP: CountCap = { limit: 1_000_000, unit: "calls" };

/**
 * Past this many contexts per sample, a manual body is too short for the timer: every context is a
 * live world held for the whole sample, so the cap bounds that memory and fails the run instead.
 */
const MANUAL_CAP: CountCap = { limit: 64, unit: "contexts" };

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
 * builds worlds whose cost the clock never sees, and a synchronous run cannot be cut short. The
 * counts are samples, not body calls, so a sample's context count leaves them unchanged.
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
type RunBench = (budgets: Budgets, sample: () => void, hooks: FnOptions) => Task;

/** Bun's `noInline` from `bun:jsc`: keeps JavaScriptCore from inlining a function into its callers. */
export type NoInline = typeof bunNoInline;

/**
 * How a benchmark builds its context and what it times.
 *
 * A `warmed` benchmark builds one context, warms the body up on it, times every sample on it, and
 * destroys its world once timing ends, so its body must leave the context as it found it. A
 * `manual` benchmark builds fresh contexts for every sample, warmup included, runs the body once on
 * each, and destroys every one of the sample's worlds after its last body call, so its body may
 * consume the world freely.
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
  /**
   * The clock tinybench times every sample on, which the timer-step probe and warmup also read;
   * defaults to the provider tinybench resolves for `"auto"`: `process.hrtime.bigint()` on Node,
   * `Bun.nanoseconds()` on Bun.
   */
  readonly timestampProvider?: TimestampProvider;
}

/**
 * Measures one benchmark with tinybench's synchronous runner.
 *
 * tinybench times every sample, reading its clock immediately before and after the per-sample
 * function, and the timer-step probe and warmup read that same clock, so the three cannot disagree
 * on its step. The timer step is measured at startup from the clock's deltas. Warmup runs, then
 * `globalThis.gc()` collects once, then the timed samples run; no build or destroy falls inside a
 * sample's clock reads. A sample's count starts at 1, and every warmup sample that spans fewer than
 * `MIN_STEPS_PER_SAMPLE` timer steps grows it in proportion to how far short it fell (by
 * `ZERO_STEP_GROWTH` when it read no step); every timed sample runs the count warmup settled on: a
 * warmed sample runs that many consecutive body calls on its one context, and a manual sample builds
 * that many contexts and runs the body once on each. Every statistic is tinybench's per-sample one
 * divided by the count.
 *
 * @param lifecycle - The benchmark to measure.
 * @param options - Overrides for what the engine provides.
 * @returns The timed samples' statistics, in nanoseconds per body call; every percentile is
 * linearly interpolated from the retained samples.
 * @throws Error when no garbage collector is exposed, before anything runs.
 * @throws Error when Bun is running but `bun:jsc` cannot be loaded, before anything runs.
 * @throws Error when tinybench loses the task, ends the run in a state other than completed, or
 * keeps no samples, or when a manual sample runs without all of its contexts.
 * @throws Error when warmup asks for more calls per warmed sample than `WARMED_CAP` allows, or more
 * contexts per manual sample than `MANUAL_CAP` allows, naming the count it asked for: the body is
 * too short to time at that cap. No sample runs that count, and every world built so far is
 * destroyed first.
 * @throws Whatever `build` or `body` throws, once every world built so far is destroyed: a warmed
 * benchmark's one world, or every world a manual benchmark's failing sample built. An `Error`
 * propagates unchanged, and so does any value a warmed benchmark's `build` throws, since it runs
 * before tinybench does; tinybench wraps any other non-`Error` value in a new `Error`.
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
  const clock = options.timestampProvider ?? autoTimestampProvider();
  const stepMs = timerStepMs(clock);
  const runBench: RunBench = (budgets, sample, hooks) => {
    noInline?.(sample);
    const task = benchTask(budgets, clock, sample, hooks);
    task.warmupSync();
    collect();
    task.runSync();
    return task;
  };
  return lifecycle.kind === "warmed"
    ? measureWarmed(lifecycle, clock, stepMs, runBench)
    : measureManual(lifecycle, clock, stepMs, runBench);
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
 * The timestamp provider tinybench resolves for `"auto"`, read from a `Bench` so the probe, warmup
 * and tinybench's own sample timing share one clock.
 *
 * @returns `process.hrtime.bigint()`'s provider on Node, `Bun.nanoseconds()`'s on Bun.
 */
function autoTimestampProvider(): TimestampProvider {
  return new Bench({ timestampProvider: "auto" }).timestampProvider;
}

/**
 * Measures the timer's step by polling `clock` across `STEP_PROBES` changes of its reading.
 *
 * @param clock - The clock to probe.
 * @returns The smallest change seen, in milliseconds.
 */
function timerStepMs(clock: TimestampProvider): number {
  let step = Number.POSITIVE_INFINITY;
  let last = clock.fn();
  for (let seen = 0; seen < STEP_PROBES;) {
    const now = clock.fn();
    if (now !== last) {
      step = Math.min(step, elapsedMs(clock, last, now));
      last = now;
      seen += 1;
    }
  }
  return step;
}

/**
 * The time between two readings of `clock`.
 *
 * @param clock - The clock both readings came from.
 * @param start - The earlier reading.
 * @param end - The later reading.
 * @returns The time from `start` to `end`, in milliseconds.
 */
function elapsedMs(clock: TimestampProvider, start: TimestampValue, end: TimestampValue): number {
  // A bigint reading is whole nanoseconds since an arbitrary origin; converting both to numbers
  // before subtracting would round away the nanoseconds once that origin lies far enough back.
  return clock.toMs(
    typeof start === "bigint" && typeof end === "bigint"
      ? end - start
      : Number(end) - Number(start),
  );
}

// Both samplers below: tinybench's hooks never see a sample's span, so a warmup sample reads the
// clock around its own body calls to settle the count, while a timed sample reads nothing and leaves
// tinybench's two reads around it as the only ones.
function measureWarmed<C extends { world: World }>(
  { build, body }: BenchLifecycle<C>,
  clock: TimestampProvider,
  stepMs: number,
  runBench: RunBench,
): Measurement {
  const ctx = build();
  try {
    let calls = 1;
    let warming = false;
    let spanMs: number | undefined;
    const sample = (): void => {
      if (warming) {
        const started = clock.fn();
        for (let call = 0; call < calls; call++) body(ctx);
        spanMs = elapsedMs(clock, started, clock.fn());
      } else {
        for (let call = 0; call < calls; call++) body(ctx);
      }
    };
    const task = runBench(WARMED_BUDGETS, sample, {
      beforeEach: (mode) => {
        warming = mode === "warmup";
        spanMs = undefined;
      },
      afterEach: () => {
        calls = settledCount(calls, spanMs, stepMs, WARMED_CAP);
      },
    });
    return statistics(task, calls);
  } finally {
    destroyWorld(ctx.world);
  }
}

function measureManual<C extends { world: World }>(
  { build, body }: BenchLifecycle<C>,
  clock: TimestampProvider,
  stepMs: number,
  runBench: RunBench,
): Measurement {
  let contexts = 1;
  let warming = false;
  let spanMs: number | undefined;
  const built: C[] = [];
  const sample = (): void => {
    if (built.length !== contexts)
      throw new Error("a manual sample ran without all of its contexts");
    if (warming) {
      const started = clock.fn();
      for (const ctx of built) body(ctx);
      spanMs = elapsedMs(clock, started, clock.fn());
    } else {
      for (const ctx of built) body(ctx);
    }
  };
  const task = runBench(MANUAL_BUDGETS, sample, {
    beforeEach: (mode) => {
      warming = mode === "warmup";
      spanMs = undefined;
      while (built.length < contexts) built.push(build());
    },
    // tinybench runs this even when `beforeEach` threw, so a build that fails partway through a
    // sample's setup still has the contexts built before it destroyed: `built` holds exactly those.
    afterEach: () => {
      for (const ctx of built.splice(0)) destroyWorld(ctx.world);
      contexts = settledCount(contexts, spanMs, stepMs, MANUAL_CAP);
    },
  });
  return statistics(task, contexts);
}

/**
 * The count the next sample runs, settled during warmup and fixed once timing begins, so every
 * timed sample runs the same count.
 *
 * Each warmup sample decides on its own span alone, so a later short sample grows the count again
 * even after an earlier one reached `MIN_STEPS_PER_SAMPLE` steps.
 *
 * @param count - The count the sample that just ended ran.
 * @param spanMs - That sample's span, in milliseconds, which only a warmup sample reads; `undefined`
 * for a timed sample, so timing never changes the count, and for a warmup sample that threw before
 * reading it, so the cap never masks its error.
 * @param stepMs - The timer's step, in milliseconds.
 * @param cap - The largest count the driver may run.
 * @returns `ceil(count × MIN_STEPS_PER_SAMPLE / steps)` when the sample spanned `steps` timer steps,
 * fewer than `MIN_STEPS_PER_SAMPLE`; `count × ZERO_STEP_GROWTH` when it read no step; else `count`
 * unchanged.
 * @throws Error when the grown count exceeds `cap.limit`, naming the count asked for.
 */
function settledCount(
  count: number,
  spanMs: number | undefined,
  stepMs: number,
  cap: CountCap,
): number {
  if (spanMs === undefined) return count;
  // A span is a whole number of timer steps; rounding recovers it from the millisecond floats.
  const steps = Math.round(spanMs / stepMs);
  if (steps >= MIN_STEPS_PER_SAMPLE) return count;
  const grown =
    steps === 0 ? count * ZERO_STEP_GROWTH : Math.ceil((count * MIN_STEPS_PER_SAMPLE) / steps);
  if (grown > cap.limit) {
    throw new Error(
      `warmup asked for ${grown} ${cap.unit} per sample: the body is too short to time at the cap of ${cap.limit} ${cap.unit}`,
    );
  }
  return grown;
}

/**
 * Adds `sample` to a bench of its own as a synchronous task that keeps its samples.
 *
 * @param budgets - The bench's stopping rule for warmup and the timed run.
 * @param clock - The clock the bench times each call of `sample` on.
 * @param sample - The per-sample function; tinybench times each call of it.
 * @param hooks - The task's lifecycle hooks.
 * @returns The task, ready for `warmupSync` then `runSync`.
 * @throws Error when tinybench does not return the task it was given.
 */
function benchTask(
  budgets: Budgets,
  clock: TimestampProvider,
  sample: () => void,
  hooks: FnOptions,
): Task {
  const bench = new Bench({
    ...budgets,
    retainSamples: true,
    throws: true,
    timestampProvider: clock,
    warmup: false,
  });
  // Without `async: false`, adding the task calls it once to detect whether it is async.
  bench.add(TASK_NAME, sample, { ...hooks, async: false });
  const task = bench.getTask(TASK_NAME);
  if (task === undefined) throw new Error(`tinybench lost the task "${TASK_NAME}"`);
  return task;
}

/**
 * The statistics of a completed task's retained samples, per body call and in nanoseconds.
 *
 * @param task - A task whose timed run completed.
 * @param count - The body calls each timed sample ran.
 * @returns The samples' extremes, percentiles, and mean, each divided by `count`, and how many
 * samples there were.
 * @throws Error when the task did not complete or kept no samples.
 */
function statistics(task: Task, count: number): Measurement {
  const { result } = task;
  if (result.state !== "completed") throw new Error(`the benchmark ended ${result.state}`);
  const retained: SortedSamples | undefined = result.latency.samples;
  if (retained === undefined) throw new Error("tinybench kept no samples");
  const ns = retained.map((ms) => (ms * NS_PER_MS) / count);
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
