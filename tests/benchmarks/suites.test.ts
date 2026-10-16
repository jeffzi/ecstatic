import { createWorld, getStorage, type World } from "ecstatic";
import { describe, expect, it } from "vitest";

import { bgArch, Position } from "../../benchmarks/archetypes.js";
import { DEFAULT_N, makeThroughputWorld, warmedBench } from "../../benchmarks/helpers.js";
import { firstTimedBody, liveValues } from "./fixtures.js";

/** The context a recorded benchmark builds: a bare world and nothing else. */
interface Ctx {
  world: World;
}

/** A `warmedBench` generator started over a recording body, with what it has built and received. */
interface Started {
  gen: Generator<unknown, unknown, unknown>;
  built: Ctx[];
  received: Ctx[];
}

/** Starts a `warmedBench` whose build records each context it makes and whose body records each one it gets. */
function startRecorded(): Started {
  const built: Ctx[] = [];
  const received: Ctx[] = [];
  const gen = warmedBench(
    () => {
      const ctx = { world: createWorld() };
      built.push(ctx);
      return ctx;
    },
    (ctx) => {
      received.push(ctx);
    },
  )();
  return { gen, built, received };
}

describe("warmedBench", () => {
  it("runs the body once, untimed, before yielding it to mitata's batched timing", () => {
    const started = startRecorded();

    const first = started.gen.next();

    expect(started.received).toHaveLength(1);
    expect(first.value).toStrictEqual({ heap: false, bench: expect.any(Function) });
  });

  it("times the body over the context the warmup ran over", () => {
    const started = startRecorded();
    const body = firstTimedBody(started.gen);

    body();

    expect(started.built).toHaveLength(1);
    expect(started.received[0]).toBe(started.built[0]);
    expect(started.received[1]).toBe(started.built[0]);
  });

  it("destroys the world once mitata resumes it after timing", () => {
    const started = startRecorded();
    started.gen.next();

    const last = started.gen.next();

    expect(last.done).toBe(true);
    expect(started.built[0]?.world.destroyed).toBe(true);
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
