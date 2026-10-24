import { spawnSync } from "node:child_process";
import { join } from "node:path";

import type { World } from "ecstatic";
import { Bench } from "tinybench";
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

import { type BenchLifecycle, measure, type NoInline } from "../../benchmarks/measure.js";
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

/** Reads the simulated clock, in milliseconds as `performance.now()` reports them. */
function readClock(): number {
  if (sim.trace.at(-1) === "clock") sim.ns += 1;
  sim.trace.push("clock");
  return (Math.floor(sim.ns / sim.stepNs) * sim.stepNs) / NS_PER_MS;
}

/** How many times `event` appears in the trace between `from` and `to`. */
function count(event: string, from = 0, to = sim.trace.length): number {
  return sim.trace.slice(from, to).filter((e) => e === event).length;
}

/** The number of body calls before the collection: the warmup samples. */
function warmupBodyCalls(): number {
  return count("body", 0, sim.trace.indexOf("gc"));
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
  vi.spyOn(performance, "now").mockImplementation(readClock);
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

    await measure(lifecycle);

    expect(lifecycleOrder()).toStrictEqual(["build", "body", "gc", "body", "destroy"]);
    expect([count("build"), count("destroy")]).toStrictEqual([1, 1]);
  });

  it("runs every body call against the one context it built", async () => {
    const { lifecycle, built, received } = recorder({ kind: "warmed" });

    await measure(lifecycle);

    expect(received.every((ctx) => ctx === built[0])).toBe(true);
  });

  it.each(BODY_FAILURE_PHASES)(
    "destroys the world once and rethrows when the body throws during $phase",
    async ({ fails }) => {
      const { lifecycle, bodyError } = recorder({ kind: "warmed", bodyFails: fails });

      const outcome = measure(lifecycle);

      await expect(outcome).rejects.toBe(bodyError);
      expect(count("destroy")).toBe(1);
    },
  );
});

describe("measure on a manual benchmark", () => {
  it("builds a fresh context for every sample and runs the body once on it", async () => {
    const { lifecycle, built, received } = recorder({ kind: "manual" });

    await measure(lifecycle);

    expect(new Set(built).size).toBe(received.length);
    expect(received.every((ctx, i) => ctx === built[i])).toBe(true);
  });

  it("destroys each sample's world right after its body call", async () => {
    const { lifecycle } = recorder({ kind: "manual" });

    await measure(lifecycle);

    const events = sim.trace.filter((e) => e === "build" || e === "body" || e === "destroy");
    expect(events.join(",")).toBe(
      Array(events.length / 3)
        .fill("build,body,destroy")
        .join(","),
    );
  });

  it.each(BODY_FAILURE_PHASES)(
    "destroys the failing sample's world and rethrows when the body throws during $phase",
    async ({ fails }) => {
      const { lifecycle, bodyError } = recorder({ kind: "manual", bodyFails: fails });

      const outcome = measure(lifecycle);

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

      const outcome = measure(lifecycle);

      await expect(outcome).rejects.toBe(buildError);
      expect(count("destroy")).toBe(built.length);
    },
  );
});

describe("measure's timing", () => {
  it.each(KINDS)(
    "leaves a %s benchmark's times unchanged by a slow build and destroy",
    async (kind) => {
      const { lifecycle } = recorder({ kind, bodyNs: 100_000, buildNs: NS_PER_MS });
      sim.destroyNs = NS_PER_MS;

      const result = await measure(lifecycle);

      expect(result).toStrictEqual(allTimes(100_000));
    },
  );

  it("reports nanosecond statistics, interpolating every percentile from the retained samples", async () => {
    const costs = [1000, 2000, 3000, 4000];
    const { lifecycle } = recorder({
      kind: "manual",
      bodyNs: (call) => costs[call % costs.length] ?? Number.NaN,
    });

    const result = await measure(lifecycle);

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
    { stepNs: 1000, bodyNs: 100_000 },
    { stepNs: 100, bodyNs: 10_000 },
  ])(
    "times one call per warmed sample when a call spans 100 steps of a $stepNs ns timer",
    async ({ stepNs, bodyNs }) => {
      sim.stepNs = stepNs;
      const { lifecycle } = recorder({ kind: "warmed", bodyNs });

      await measure(lifecycle);

      expect(new Set(callsPerTimedSample())).toStrictEqual(new Set([1]));
    },
  );

  it.each([
    { stepNs: 1000, bodyNs: 99_000 },
    { stepNs: 10_000, bodyNs: 100_000 },
  ])(
    "times a fixed batch per warmed sample spanning 100 steps of a $stepNs ns timer for a $bodyNs ns body",
    async ({ stepNs, bodyNs }) => {
      sim.stepNs = stepNs;
      const { lifecycle } = recorder({ kind: "warmed", bodyNs });

      await measure(lifecycle);

      const batches = [...new Set(callsPerTimedSample())];
      expect(batches).toHaveLength(1);
      expect((batches[0] ?? 0) * bodyNs).toBeGreaterThanOrEqual(100 * stepNs);
    },
  );

  it("keeps the batch warmup fixed when the timed calls turn shorter", async () => {
    let timed = false;
    vi.stubGlobal("gc", () => {
      sim.trace.push("gc");
      timed = true;
    });
    sim.stepNs = 20_000;
    const { lifecycle } = recorder({ kind: "warmed", bodyNs: () => (timed ? 1 : 2) * NS_PER_MS });

    await measure(lifecycle);

    expect(new Set(callsPerTimedSample())).toStrictEqual(new Set([1]));
  });

  it("reports a batched sample's span divided by its call count", async () => {
    sim.stepNs = 1000;
    const { lifecycle } = recorder({ kind: "warmed", bodyNs: 1000 });

    const result = await measure(lifecycle);

    expect(result).toStrictEqual(allTimes(1000));
    const batches = [...new Set(callsPerTimedSample())];
    expect(batches).toHaveLength(1);
    expect((batches[0] ?? 0) * 1000).toBeGreaterThanOrEqual(100 * 1000);
  });

  it.each(KINDS)(
    "collects garbage once on a %s benchmark, after warmup and outside any sample's clock reads",
    async (kind) => {
      const { lifecycle } = recorder({ kind });

      await measure(lifecycle);

      const gcAt = sim.trace.indexOf("gc");
      const between = sim.trace.slice(
        sim.trace.lastIndexOf("body", gcAt) + 1,
        sim.trace.indexOf("body", gcAt),
      );
      expect(count("gc")).toBe(1);
      expect(between.filter((e) => e === "clock" || e === "gc")).toStrictEqual([
        "clock",
        "gc",
        "clock",
      ]);
    },
  );

  it("throws before anything runs when no garbage collector is exposed", async () => {
    vi.stubGlobal("gc", undefined);
    const { lifecycle } = recorder({ kind: "warmed" });

    const outcome = measure(lifecycle);

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

      await measure(queuing);

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

      const result = await measure(lifecycle);

      expect(warmupBodyCalls()).toBe(warmup);
      expect(result.samples).toBe(timed);
    },
  );

  it.each([{ bodyNs: 100 }, { bodyNs: 100 * NS_PER_MS }])(
    "warms a $bodyNs ns manual body for exactly 1000 samples and times exactly 2000",
    async ({ bodyNs }) => {
      const { lifecycle } = recorder({ kind: "manual", bodyNs });

      const result = await measure(lifecycle);

      expect(warmupBodyCalls()).toBe(1000);
      expect(result.samples).toBe(2000);
    },
  );
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

      await measure(lifecycle, { noInline });

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

      await measure(lifecycle);

      expect(sim.noInlined).toStrictEqual(add.mock.calls.map(([, task]) => task));
    },
  );

  it("never imports bun:jsc on Node, when loading the driver or measuring", async () => {
    vi.resetModules();
    vi.doMock("bun:jsc", bunJsc);
    const fresh = await import("../../benchmarks/measure.js");
    const { lifecycle } = recorder({ kind: "warmed" });

    await fresh.measure(lifecycle);

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
