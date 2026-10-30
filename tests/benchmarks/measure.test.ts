import { spawnSync } from "node:child_process";
import { join } from "node:path";

import type { World } from "ecstatic";
import { Bench, type TimestampProvider } from "tinybench";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  type MockInstance,
  onTestFinished,
  vi,
} from "vitest";

import {
  type BenchLifecycle,
  measure,
  type MeasureOptions,
  type Measurement,
  type NoInline,
} from "../../benchmarks/measure.js";
import { REPO_ROOT } from "../unit/plugin/tsconfig-fixtures.js";
import { type BareWorldCtx, buildBareWorld } from "./fixtures.js";
import { realBunRequired } from "./real-bun.js";

/**
 * The simulated machine every test measures on.
 *
 * `trace` holds builds, body calls, clock reads, collections, and world destroys, in the order they
 * happen. `ns` is the simulated time in whole nanoseconds; builds, bodies, and destroys advance it
 * by their cost, and a clock read that directly follows another read finds it one nanosecond on, so
 * a loop polling the clock sees it move while a sample's two reads see only what ran between them.
 * Every clock read goes through `SIM_CLOCK`, the timestamp provider each test hands the bench.
 * `stepNs` is the step the clock reports in. `noInlined` holds every function the stand-in for Bun's
 * `noInline` received.
 */
const sim = vi.hoisted(() => ({
  trace: [] as string[],
  ns: 0,
  stepNs: 1,
  destroyNs: 0,
  noInlined: [] as unknown[],
}));

// The world's release is a boundary under test: wrapping the real destroyWorld records when the
// driver releases a world, and charges the destroy's cost to the simulated clock.
vi.mock("ecstatic", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ecstatic")>();
  return {
    ...actual,
    destroyWorld: (world: World): void => {
      sim.trace.push("destroy");
      sim.ns += sim.destroyNs;
      actual.destroyWorld(world);
    },
  };
});

/** A stand-in for Bun's JSC module that records when it loads and what its `noInline` receives. */
const bunJsc = vi.hoisted(() => () => {
  sim.trace.push("bun:jsc");
  return {
    noInline: (fn: unknown): void => {
      sim.trace.push("noInline");
      sim.noInlined.push(fn);
    },
  };
});

// Loading Bun's JSC module is the boundary under test.
vi.mock("bun:jsc", bunJsc);

const NS_PER_MS = 1e6;

/** The message measuring fails with when no garbage collector is exposed. */
const NO_GC = "benchmarks require an exposed gc: run node or bun with --expose-gc";

const KINDS = ["warmed", "manual"] as const;
type Kind = (typeof KINDS)[number];

/** When a body fails: from its first call, or only once timing has begun after the collection. */
const BODY_FAILURE_PHASES = [
  { phase: "warmup", fails: (): boolean => true },
  { phase: "timing", fails: (): boolean => sim.trace.includes("gc") },
];

/** How a recorded benchmark behaves; costs are in simulated nanoseconds. */
interface RecorderOptions {
  readonly kind: Kind;
  readonly bodyNs?: number | ((call: number) => number);
  readonly buildNs?: number;
  readonly bodyFails?: () => boolean;
  readonly buildFails?: () => boolean;
}

/** A recorded benchmark, every context it built and its body received, and the errors it throws. */
interface Recorder {
  readonly lifecycle: BenchLifecycle<BareWorldCtx>;
  readonly built: BareWorldCtx[];
  readonly received: BareWorldCtx[];
  readonly bodyError: Error;
  readonly buildError: Error;
}

/** A benchmark whose build and body trace themselves and charge their cost to the simulated clock. */
function recorder({
  kind,
  bodyNs = 100 * NS_PER_MS,
  buildNs = 0,
  bodyFails = () => false,
  buildFails = () => false,
}: RecorderOptions): Recorder {
  const built: BareWorldCtx[] = [];
  const received: BareWorldCtx[] = [];
  const bodyError = new Error("the body failed");
  const buildError = new Error("the build failed");
  const cost = typeof bodyNs === "number" ? () => bodyNs : bodyNs;
  const build = (): BareWorldCtx => {
    sim.trace.push("build");
    sim.ns += buildNs;
    if (buildFails()) throw buildError;
    const ctx = buildBareWorld();
    built.push(ctx);
    return ctx;
  };
  const body = (ctx: BareWorldCtx): void => {
    sim.trace.push("body");
    sim.ns += cost(received.length);
    received.push(ctx);
    if (bodyFails()) throw bodyError;
  };
  return { lifecycle: { kind, build, body }, built, received, bodyError, buildError };
}

/** Reads the simulated clock, in whole nanoseconds as `process.hrtime.bigint()` reports them. */
function readClock(): bigint {
  if (sim.trace.at(-1) === "clock") sim.ns += 1;
  sim.trace.push("clock");
  return BigInt(Math.floor(sim.ns / sim.stepNs) * sim.stepNs);
}

/** The simulated clock as a timestamp provider, shaped like tinybench's hrtime one. */
const SIM_CLOCK: TimestampProvider = {
  name: "simulated",
  fn: readClock,
  toMs: (ns) => Number(ns) / NS_PER_MS,
  fromMs: (ms) => BigInt(Math.round(ms * NS_PER_MS)),
};

/** The error a read of `performance.now()` throws: the driver may read only the bench's clock. */
const FOREIGN_CLOCK = "read performance.now(), not the clock the bench times on";

/** Measures `lifecycle` with the bench timing on the simulated clock. */
function measureOnSim(
  lifecycle: BenchLifecycle<BareWorldCtx>,
  options: MeasureOptions = {},
): Promise<Measurement> {
  return measure(lifecycle, { timestampProvider: SIM_CLOCK, ...options });
}

/** How many times `event` appears in the trace between `from` and `to`. */
function count(event: string, from = 0, to = sim.trace.length): number {
  return sim.trace.slice(from, to).filter((e) => e === event).length;
}

/** The number of body calls before the collection. */
function warmupBodyCalls(): number {
  return count("body", 0, sim.trace.indexOf("gc"));
}

/** The number of samples before the collection: each run of consecutive body calls is one. */
function warmupSamples(): number {
  return sim.trace
    .slice(0, sim.trace.indexOf("gc"))
    .filter((e, i, events) => e === "body" && events[i - 1] !== "body").length;
}

/** The builds, body calls, and destroys of the trace, as runs of one event and their lengths. */
function lifecycleRuns(): [string, number][] {
  const runs: [string, number][] = [];
  for (const event of sim.trace) {
    if (event !== "build" && event !== "body" && event !== "destroy") continue;
    const last = runs.at(-1);
    if (last?.[0] === event) {
      last[1] += 1;
    } else {
      runs.push([event, 1]);
    }
  }
  return runs;
}

/** The lifecycle events of the trace, each run of repeats collapsed into one. */
function lifecycleOrder(): string[] {
  const events = sim.trace.filter((e) => e !== "clock");
  return events.filter((e, i) => e !== events[i - 1]);
}

/** The number of consecutive body calls in each sample after the collection. */
function callsPerTimedSample(): number[] {
  const runs: number[] = [];
  let run = 0;
  for (const event of sim.trace.slice(sim.trace.indexOf("gc") + 1)) {
    if (event === "body") {
      run += 1;
    } else if (run > 0) {
      runs.push(run);
      run = 0;
    }
  }
  return runs;
}

/** Makes the running engine read as Bun until the current test finishes. */
function pretendBun(): void {
  Object.defineProperty(process.versions, "bun", { value: "1.4.0", configurable: true });
  onTestFinished(() => {
    Reflect.deleteProperty(process.versions, "bun");
  });
}

/** A measurement whose every time is `ns`. */
function allTimes(ns: number): Record<string, unknown> {
  const near = expect.closeTo(ns, 3);
  return {
    min: near,
    p25: near,
    p50: near,
    p75: near,
    p99: near,
    max: near,
    mean: near,
    samples: expect.any(Number),
  };
}

beforeEach(() => {
  sim.trace.length = 0;
  sim.ns = 0;
  sim.stepNs = 1;
  sim.destroyNs = 0;
  sim.noInlined.length = 0;
  vi.spyOn(performance, "now").mockImplementation(() => {
    throw new Error(FOREIGN_CLOCK);
  });
  vi.stubGlobal("gc", () => {
    sim.trace.push("gc");
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("measure on a warmed benchmark", () => {
  it("builds once, warms up before the collection, times after it, then destroys the world once", async () => {
    const { lifecycle } = recorder({ kind: "warmed" });

    await measureOnSim(lifecycle);

    expect(lifecycleOrder()).toStrictEqual(["build", "body", "gc", "body", "destroy"]);
    expect([count("build"), count("destroy")]).toStrictEqual([1, 1]);
  });

  it("runs every body call against the one context it built", async () => {
    const { lifecycle, built, received } = recorder({ kind: "warmed" });

    await measureOnSim(lifecycle);

    expect(received.every((ctx) => ctx === built[0])).toBe(true);
  });

  it.each(BODY_FAILURE_PHASES)(
    "destroys the world once and rethrows when the body throws during $phase",
    async ({ fails }) => {
      const { lifecycle, bodyError } = recorder({ kind: "warmed", bodyFails: fails });

      const outcome = measureOnSim(lifecycle);

      await expect(outcome).rejects.toBe(bodyError);
      expect(count("destroy")).toBe(1);
    },
  );
});

describe("measure on a manual benchmark", () => {
  it("builds a fresh context for every sample and runs the body once on it", async () => {
    const { lifecycle, built, received } = recorder({ kind: "manual" });

    await measureOnSim(lifecycle);

    expect(new Set(built).size).toBe(received.length);
    expect(received.every((ctx, i) => ctx === built[i])).toBe(true);
  });

  it("destroys each sample's world right after its body call", async () => {
    const { lifecycle } = recorder({ kind: "manual" });

    await measureOnSim(lifecycle);

    const events = sim.trace.filter((e) => e === "build" || e === "body" || e === "destroy");
    expect(events.join(",")).toBe(
      Array(events.length / 3)
        .fill("build,body,destroy")
        .join(","),
    );
  });

  it.each([
    { stepNs: 1000, bodyNs: 199_000, contexts: 2 },
    { stepNs: 1000, bodyNs: 25_000, contexts: 8 },
    { stepNs: 1000, bodyNs: 200_000, contexts: 1 },
    { stepNs: 1000, bodyNs: 99_000, contexts: 3 },
    { stepNs: 10_000, bodyNs: 100_000, contexts: 20 },
  ])(
    "times $contexts contexts per sample for a $bodyNs ns body on a $stepNs ns timer, growing from one in proportion to how far a sample falls short of 200 steps",
    async ({ stepNs, bodyNs, contexts }) => {
      sim.stepNs = stepNs;
      const { lifecycle } = recorder({ kind: "manual", bodyNs });

      await measureOnSim(lifecycle);

      expect(new Set(callsPerTimedSample())).toStrictEqual(new Set([contexts]));
    },
  );

  it("runs the body exactly once on each context a batched sample built", async () => {
    sim.stepNs = 1000;
    const { lifecycle, built, received } = recorder({ kind: "manual", bodyNs: 25_000 });

    await measureOnSim(lifecycle);

    const builtSet = new Set(built);
    expect(received).toHaveLength(built.length);
    expect(new Set(received).size).toBe(received.length);
    expect(received.every((ctx) => builtSet.has(ctx))).toBe(true);
  });

  it("builds all of a batched sample's contexts before its first body call and destroys them after its last", async () => {
    sim.stepNs = 1000;
    const { lifecycle } = recorder({ kind: "manual", bodyNs: 25_000 });

    await measureOnSim(lifecycle);

    const runs = lifecycleRuns();
    const samples = Array.from({ length: runs.length / 3 }, (_, i) => runs.slice(3 * i, 3 * i + 3));
    expect(runs.length % 3).toBe(0);
    expect(
      samples.every(
        ([build, body, destroy]) =>
          build?.[0] === "build" &&
          body?.[0] === "body" &&
          destroy?.[0] === "destroy" &&
          build[1] === body[1] &&
          body[1] === destroy[1],
      ),
    ).toBe(true);
    expect(samples.at(-1)?.[1]?.[1]).toBe(8);
  });

  it("destroys every context a batched sample built and rethrows when the body throws on a later one", async () => {
    sim.stepNs = 1000;
    const { lifecycle, built, bodyError } = recorder({
      kind: "manual",
      bodyNs: 25_000,
      bodyFails: () => sim.trace.at(-2) === "body",
    });

    const outcome = measureOnSim(lifecycle);

    await expect(outcome).rejects.toBe(bodyError);
    expect(count("destroy")).toBe(built.length);
  });

  it("rethrows the body's error, not a cap error, when a sample grown to the cap fails before its span is read", async () => {
    sim.stepNs = 1000;
    let calls = 0;
    const { lifecycle, built, bodyError } = recorder({
      kind: "manual",
      bodyNs: (call) => (call === 0 ? 25_000 : 3125),
      bodyFails: () => {
        calls += 1;
        return calls === 10;
      },
    });

    const outcome = measureOnSim(lifecycle);

    await expect(outcome).rejects.toBe(bodyError);
    expect(count("destroy")).toBe(built.length);
  });

  it("destroys the contexts a batched sample built before its build threw, and rethrows", async () => {
    sim.stepNs = 1000;
    const { lifecycle, built, buildError } = recorder({
      kind: "manual",
      bodyNs: 25_000,
      buildFails: () => sim.trace.at(-2) === "build",
    });

    const outcome = measureOnSim(lifecycle);

    await expect(outcome).rejects.toBe(buildError);
    expect(count("destroy")).toBe(built.length);
  });

  it.each(BODY_FAILURE_PHASES)(
    "destroys the failing sample's world and rethrows when the body throws during $phase",
    async ({ fails }) => {
      const { lifecycle, bodyError } = recorder({ kind: "manual", bodyFails: fails });

      const outcome = measureOnSim(lifecycle);

      await expect(outcome).rejects.toBe(bodyError);
      const events = sim.trace.filter((e) => e !== "clock" && e !== "gc");
      expect(events.slice(-3)).toStrictEqual(["build", "body", "destroy"]);
      expect(count("destroy")).toBe(count("build"));
    },
  );

  it.each([
    { which: "first", fails: (): boolean => true },
    { which: "a later", fails: (): boolean => sim.trace.includes("destroy") },
  ])(
    "rethrows the build's error when the $which sample's build throws, destroying only the worlds built",
    async ({ fails }) => {
      const { lifecycle, built, buildError } = recorder({ kind: "manual", buildFails: fails });

      const outcome = measureOnSim(lifecycle);

      await expect(outcome).rejects.toBe(buildError);
      expect(count("destroy")).toBe(built.length);
    },
  );
});

describe("measure's timing", () => {
  it.each([
    { kind: "warmed", stepNs: 1, bodyNs: 100_000 },
    { kind: "manual", stepNs: 1, bodyNs: 100_000 },
    { kind: "manual", stepNs: 1000, bodyNs: 25_000 },
  ] as const)(
    "leaves a $kind benchmark's times unchanged by a slow build and destroy for a $bodyNs ns body on a $stepNs ns timer",
    async ({ kind, stepNs, bodyNs }) => {
      sim.stepNs = stepNs;
      const { lifecycle } = recorder({ kind, bodyNs, buildNs: NS_PER_MS });
      sim.destroyNs = NS_PER_MS;

      const result = await measureOnSim(lifecycle);

      expect(result).toStrictEqual(allTimes(bodyNs));
    },
  );

  it("reports nanosecond statistics, interpolating every percentile from the retained samples", async () => {
    const costs = [1000, 2000, 3000, 4000];
    const { lifecycle } = recorder({
      kind: "manual",
      bodyNs: (call) => costs[call % costs.length] ?? Number.NaN,
    });

    const result = await measureOnSim(lifecycle);

    expect(result).toStrictEqual({
      min: expect.closeTo(1000, 3),
      p25: expect.closeTo(1750, 3),
      p50: expect.closeTo(2500, 3),
      p75: expect.closeTo(3250, 3),
      p99: expect.closeTo(4000, 3),
      max: expect.closeTo(4000, 3),
      mean: expect.closeTo(2500, 3),
      samples: expect.any(Number),
    });
  });

  it.each([
    { stepNs: 1000, bodyNs: 200_000, calls: 1 },
    { stepNs: 100, bodyNs: 20_000, calls: 1 },
    { stepNs: 1000, bodyNs: 199_000, calls: 2 },
    { stepNs: 1000, bodyNs: 99_000, calls: 3 },
    { stepNs: 10_000, bodyNs: 100_000, calls: 20 },
  ])(
    "times $calls calls per warmed sample for a $bodyNs ns body on a $stepNs ns timer, growing from one in proportion to how far a sample falls short of 200 steps",
    async ({ stepNs, bodyNs, calls }) => {
      sim.stepNs = stepNs;
      const { lifecycle } = recorder({ kind: "warmed", bodyNs });

      await measureOnSim(lifecycle);

      expect(new Set(callsPerTimedSample())).toStrictEqual(new Set([calls]));
    },
  );

  it.each(KINDS)(
    "keeps the batch a %s benchmark's warmup settled when the timed calls turn shorter",
    async (kind) => {
      let timed = false;
      vi.stubGlobal("gc", () => {
        sim.trace.push("gc");
        timed = true;
      });
      sim.stepNs = 1000;
      const { lifecycle } = recorder({ kind, bodyNs: () => (timed ? 50_000 : 100_000) });

      await measureOnSim(lifecycle);

      expect(new Set(callsPerTimedSample())).toStrictEqual(new Set([2]));
    },
  );

  // Warmup ends after exactly 16 warmed samples (the first 15 alone pass its 250 ms) or 1000
  // manual ones, so the short call below is the last warmup sample's.
  it.each([
    { kind: "warmed", bodyNs: 20_000_000, lastWarmupCall: 15 },
    { kind: "manual", bodyNs: 200_000, lastWarmupCall: 999 },
  ] as const)(
    "keeps the count a $kind benchmark's last, short warmup sample grew it to through every timed sample",
    async ({ kind, bodyNs, lastWarmupCall }) => {
      sim.stepNs = 1000;
      const { lifecycle } = recorder({
        kind,
        bodyNs: (call) => (call === lastWarmupCall ? 100_000 : bodyNs),
      });

      await measureOnSim(lifecycle);

      expect(new Set(callsPerTimedSample())).toStrictEqual(new Set([2]));
    },
  );

  it.each(KINDS)(
    "grows a %s benchmark's count again when warmup calls turn faster after a sample spanned 200 steps",
    async (kind) => {
      sim.stepNs = 1000;
      const { lifecycle } = recorder({ kind, bodyNs: (call) => (call === 0 ? 200_000 : 50_000) });

      await measureOnSim(lifecycle);

      expect(new Set(callsPerTimedSample())).toStrictEqual(new Set([4]));
    },
  );

  it("multiplies the count by 100 after a warmup sample that read no timer step", async () => {
    sim.stepNs = 1000;
    const { lifecycle } = recorder({ kind: "warmed", bodyNs: (call) => (call === 0 ? 0 : 2000) });

    await measureOnSim(lifecycle);

    expect(new Set(callsPerTimedSample())).toStrictEqual(new Set([100]));
  });

  it.each(KINDS)("reports a batched %s sample's span divided by its call count", async (kind) => {
    sim.stepNs = 1000;
    const { lifecycle } = recorder({ kind, bodyNs: 25_000 });

    const result = await measureOnSim(lifecycle);

    expect(result).toStrictEqual(allTimes(25_000));
    const batches = [...new Set(callsPerTimedSample())];
    expect(batches).toHaveLength(1);
    expect((batches[0] ?? 0) * 25_000).toBeGreaterThanOrEqual(200 * 1000);
  });

  it.each(KINDS)(
    "collects garbage once on a %s benchmark, after warmup and outside any sample's clock reads",
    async (kind) => {
      const { lifecycle } = recorder({ kind });

      await measureOnSim(lifecycle);

      const gcAt = sim.trace.indexOf("gc");
      const between = sim.trace.slice(
        sim.trace.lastIndexOf("body", gcAt) + 1,
        sim.trace.indexOf("body", gcAt),
      );
      expect(count("gc")).toBe(1);
      expect(between.filter((e) => e === "clock" || e === "gc").join(" ")).toMatch(
        /^(clock )+gc clock$/,
      );
    },
  );

  it.each(KINDS)(
    "times each %s sample between one read of the bench's clock before its first body call and one after its last",
    async (kind) => {
      sim.stepNs = 1000;
      const { lifecycle } = recorder({ kind, bodyNs: 25_000 });

      const result = await measureOnSim(lifecycle);

      const timed = sim.trace
        .slice(sim.trace.indexOf("gc") + 1)
        .filter((e) => e === "clock" || e === "body")
        .filter((e, i, events) => e !== "body" || events[i - 1] !== "body");
      expect(timed).toStrictEqual(
        Array.from({ length: result.samples }, () => ["clock", "body", "clock"]).flat(),
      );
    },
  );

  it("throws before anything runs when no garbage collector is exposed", async () => {
    vi.stubGlobal("gc", undefined);
    const { lifecycle } = recorder({ kind: "warmed" });

    const outcome = measureOnSim(lifecycle);

    await expect(outcome).rejects.toThrow(NO_GC);
    expect(sim.trace).toStrictEqual([]);
  });

  it.each(KINDS)(
    "samples a %s benchmark synchronously, so a microtask its first call queues runs after the last",
    async (kind) => {
      let queued = false;
      const { lifecycle } = recorder({ kind });
      const body = lifecycle.body;
      const queuing: BenchLifecycle<BareWorldCtx> = {
        ...lifecycle,
        body: (ctx) => {
          if (!queued) {
            queued = true;
            queueMicrotask(() => sim.trace.push("microtask"));
          }
          body(ctx);
        },
      };

      await measureOnSim(queuing);

      expect(sim.trace.indexOf("microtask")).toBeGreaterThan(sim.trace.lastIndexOf("body"));
    },
  );
});

describe("measure's stopping rule", () => {
  it.each([
    { bodyNs: 1_001_000, warmup: 250, timed: 1000 },
    { bodyNs: 100 * NS_PER_MS, warmup: 16, timed: 64 },
  ])(
    "warms a $bodyNs ns warmed body for $warmup samples and times $timed: 250 ms and 16 samples, then 1000 ms and 64",
    async ({ bodyNs, warmup, timed }) => {
      const { lifecycle } = recorder({ kind: "warmed", bodyNs });

      const result = await measureOnSim(lifecycle);

      expect(warmupBodyCalls()).toBe(warmup);
      expect(result.samples).toBe(timed);
    },
  );

  it.each([
    { stepNs: 1, bodyNs: 100 * NS_PER_MS },
    { stepNs: 1000, bodyNs: 25_000 },
  ])(
    "warms a $bodyNs ns manual body on a $stepNs ns timer for exactly 1000 samples and times exactly 2000",
    async ({ stepNs, bodyNs }) => {
      sim.stepNs = stepNs;
      const { lifecycle } = recorder({ kind: "manual", bodyNs });

      const result = await measureOnSim(lifecycle);

      expect(warmupSamples()).toBe(1000);
      expect(result.samples).toBe(2000);
    },
  );
});

describe("measure's batch cap", () => {
  it("fails a warmed run naming the call count asked for past 1,000,000, without running that sample", async () => {
    sim.stepNs = 1000;
    const { lifecycle, received } = recorder({
      kind: "warmed",
      bodyNs: (call) => {
        if (call === 0) return 1000;
        if (call <= 200) return 5;
        return 0;
      },
    });

    const outcome = measureOnSim(lifecycle);

    await expect(outcome).rejects.toThrow(/\b4000000\b/);
    expect(received).toHaveLength(1 + 200 + 40_000);
    expect(count("destroy")).toBe(1);
  });

  it("fails a manual run naming the context count asked for past 64, before building them, destroying every context built", async () => {
    sim.stepNs = 1000;
    const { lifecycle, built } = recorder({
      kind: "manual",
      bodyNs: (call) => (call === 0 ? 10_000 : 1500),
    });

    const outcome = measureOnSim(lifecycle);

    await expect(outcome).rejects.toThrow(/\b134\b/);
    expect(built).toHaveLength(1 + 20);
    expect(count("destroy")).toBe(built.length);
  });
});

/** Spies on tinybench's `Bench.add`, passing every call through, until the test finishes. */
function spyOnTaskAdds(): MockInstance<Bench["add"]> {
  const spy = vi.spyOn(Bench.prototype, "add");
  onTestFinished(() => {
    spy.mockRestore();
  });
  return spy;
}

describe("measure's noInline", () => {
  it.each(KINDS)(
    "applies an injected noInline to exactly the function a %s benchmark hands tinybench, before handing it over",
    async (kind) => {
      const noInline = vi.fn<NoInline>();
      const add = spyOnTaskAdds();
      const { lifecycle } = recorder({ kind });

      await measureOnSim(lifecycle, { noInline });

      expect(noInline.mock.calls).toStrictEqual(add.mock.calls.map(([, task]) => [task]));
      expect(Math.max(...noInline.mock.invocationCallOrder)).toBeLessThan(
        Math.min(...add.mock.invocationCallOrder),
      );
    },
  );

  it.each(KINDS)(
    "applies bun:jsc's noInline under Bun to exactly the function a %s benchmark hands tinybench",
    async (kind) => {
      pretendBun();
      const add = spyOnTaskAdds();
      const { lifecycle } = recorder({ kind });

      await measureOnSim(lifecycle);

      expect(sim.noInlined).toStrictEqual(add.mock.calls.map(([, task]) => task));
    },
  );

  it("never imports bun:jsc on Node, when loading the driver or measuring", async () => {
    vi.resetModules();
    vi.doMock("bun:jsc", bunJsc);
    const fresh = await import("../../benchmarks/measure.js");
    const { lifecycle } = recorder({ kind: "warmed" });

    await fresh.measure(lifecycle, { timestampProvider: SIM_CLOCK });

    expect(sim.trace).not.toContain("bun:jsc");
    expect(sim.noInlined).toStrictEqual([]);
  });
});

/** Whether to measure under real Bun: wherever Bun is installed, and always on CI, which installs it. */
const RUN_UNDER_BUN = realBunRequired();

/** Bun starting, then a warmed measurement's 1.25 s of warmup and timing, on a slow CI runner. */
const BUN_TIMEOUT_MS = 60_000;

describe.runIf(RUN_UNDER_BUN)("measure under real Bun", () => {
  it(
    "measures a warmed benchmark with bun:jsc's noInline loaded",
    () => {
      const script = `
const { measure } = await import(${JSON.stringify(join(REPO_ROOT, "benchmarks", "measure.ts"))});
const { makeThroughputWorld } = await import(${JSON.stringify(join(REPO_ROOT, "benchmarks", "helpers.ts"))});
let sink = 0;
const result = await measure({
  kind: "warmed",
  build: makeThroughputWorld,
  body: (ctx) => { sink += ctx.trackedStorage.n; },
});
console.log(JSON.stringify({ samples: result.samples, p50: result.p50, sank: sink > 0 }));
`;

      const run = spawnSync("bun", ["--expose-gc", "-e", script], {
        cwd: REPO_ROOT,
        encoding: "utf8",
      });

      expect(run.stderr).toBe("");
      expect(JSON.parse(run.stdout)).toStrictEqual({
        samples: expect.any(Number),
        p50: expect.any(Number),
        sank: true,
      });
    },
    BUN_TIMEOUT_MS,
  );
});
