import { createWorld, getStorage, type World } from "ecstatic";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { bgArch, Position } from "../../benchmarks/archetypes.js";
import {
  DEFAULT_N,
  makeThroughputWorld,
  manualBench,
  warmedBench,
} from "../../benchmarks/helpers.js";
import { firstTimedBody, liveValues } from "./fixtures.js";

/** Builds, body calls, clock reads, and world destroys, in the order they happen. */
const trace = vi.hoisted((): string[] => []);

// The world's release is the boundary under test: wrapping the real destroyWorld records when the
// timing helpers release a world, relative to the body and the clock.
vi.mock("ecstatic", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ecstatic")>();
  return {
    ...actual,
    destroyWorld: (world: World): void => {
      trace.push("destroy");
      actual.destroyWorld(world);
    },
  };
});

/** The context a recorded benchmark builds: a bare world and nothing else. */
interface Ctx {
  world: World;
}

/** A recording build and body, with every context they have built and received. */
interface Recorder {
  build: () => Ctx;
  body: (ctx: Ctx) => void;
  built: Ctx[];
  received: Ctx[];
}

/** Records each context `build` makes and `body` gets, tracing both; `body` throws when `fails` is set. */
function recorder({ fails = false } = {}): Recorder {
  const built: Ctx[] = [];
  const received: Ctx[] = [];
  return {
    built,
    received,
    build: () => {
      trace.push("build");
      const ctx = { world: createWorld() };
      built.push(ctx);
      return ctx;
    },
    body: (ctx) => {
      trace.push("body");
      received.push(ctx);
      if (fails) throw new Error("the body failed");
    },
  };
}

const NS_PER_MS = 1e6;

/** How far a sample's report may exceed the time the body measures for itself: a call and a clock read. */
const OVERHEAD_SLACK_NS = 2_000;

/** How many samples the overhead check takes its best of, so a scheduler pause in one cannot fail it. */
const OVERHEAD_SAMPLES = 50;

/** The clock readings, in milliseconds, the stubbed `performance.now()` returns in turn. */
const CLOCK_MS = [10, 13.5];

/** Nanoseconds between the two clock readings: what one timed call must report. */
const CLOCK_SPAN_NS = 3.5e6;

/** Stubs `performance.now()` to trace each read and return the next of `CLOCK_MS`. */
function stubClock(): void {
  let reads = 0;
  vi.spyOn(performance, "now").mockImplementation(() => {
    trace.push("clock");
    return CLOCK_MS[reads++ % CLOCK_MS.length] ?? Number.NaN;
  });
}

beforeEach(() => {
  trace.length = 0;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("warmedBench", () => {
  it("runs the body once, untimed, before yielding a manual-timing body to mitata", () => {
    const { build, body, received } = recorder();
    const gen = warmedBench(build, body)();

    const first = gen.next();

    expect(received).toHaveLength(1);
    expect(first.value).toStrictEqual({ heap: false, manual: expect.any(Function) });
  });

  it("builds the context once and runs the body exactly once per sample over it", () => {
    const { build, body, built, received } = recorder();
    const sample = firstTimedBody(warmedBench(build, body)());

    sample();
    sample();

    expect(built).toHaveLength(1);
    expect(received.map((ctx) => ctx === built[0])).toStrictEqual([true, true, true]);
  });

  it("reports in nanoseconds the span of two clock reads around exactly one body call", () => {
    const { build, body } = recorder();
    const sample = firstTimedBody(warmedBench(build, body)());
    trace.length = 0;
    stubClock();

    const reported = sample();

    expect(trace).toStrictEqual(["clock", "body", "clock"]);
    expect(reported).toBe(CLOCK_SPAN_NS);
  });

  it("reports each sample within a clock read of the time the body measures for itself", () => {
    const ownNs: number[] = [];
    const sample = firstTimedBody(
      warmedBench(
        () => ({ world: createWorld() }),
        () => {
          const started = performance.now();
          ownNs.push((performance.now() - started) * NS_PER_MS);
        },
      )(),
    );
    ownNs.length = 0;

    const excessNs = Array.from(
      { length: OVERHEAD_SAMPLES },
      (_, i) => sample() - (ownNs[i] ?? Number.NaN),
    );

    expect(Math.min(...excessNs)).toBeLessThanOrEqual(OVERHEAD_SLACK_NS);
  });

  it("destroys the world exactly once, when mitata resumes it after timing", () => {
    const { build, body } = recorder();
    const gen = warmedBench(build, body)();
    firstTimedBody(gen)();

    const last = gen.next();

    expect(last.done).toBe(true);
    expect(trace).toStrictEqual(["build", "body", "body", "destroy"]);
  });
});

describe("manualBench", () => {
  it("builds a fresh world for every iteration and runs the body once over it", () => {
    const { build, body, built, received } = recorder();
    const { manual } = manualBench(build, body);

    manual();
    manual();

    expect(built).toHaveLength(2);
    expect(built[0]).not.toBe(built[1]);
    expect(received.map((ctx, i) => ctx === built[i])).toStrictEqual([true, true]);
  });

  it("times the body alone, after the build and before the world's destroy", () => {
    const { build, body } = recorder();
    const { manual } = manualBench(build, body);
    stubClock();

    const reported = manual();

    expect(trace).toStrictEqual(["build", "clock", "body", "clock", "destroy"]);
    expect(reported).toBe(CLOCK_SPAN_NS);
  });

  it("destroys the iteration's world after a body that throws", () => {
    const { build, body } = recorder({ fails: true });
    const { manual } = manualBench(build, body);
    stubClock();

    expect(() => manual()).toThrow("the body failed");
    expect(trace).toStrictEqual(["build", "clock", "body", "destroy"]);
  });
});

describe("makeThroughputWorld", () => {
  it("builds a tracked storage of DEFAULT_N entities in a world with no background population", () => {
    const { world, trackedStorage } = makeThroughputWorld();

    expect(liveValues(trackedStorage, Position, "x")).toStrictEqual(
      Array.from({ length: DEFAULT_N }, (_, row) => row + 1),
    );
    expect(getStorage(world, bgArch).n).toBe(0);
  });
});
