import type { Storage } from "ecstatic";
import { describe, expect, it } from "vitest";

import { bgArch, Position, trackedArch } from "../../benchmarks/archetypes.js";
import { DEFAULT_N, type FrameCtx, frameBench, throughputBench } from "../../benchmarks/helpers.js";

/** A benchmark generator started over a recording body, with what that body has received so far. */
interface Started {
  gen: Generator<unknown, unknown, unknown>;
  received: unknown[];
  isDestroyed: () => boolean;
}

/** Starts `throughputBench` over a body that records the storage it is handed. */
function startThroughput(): Started {
  const received: Storage<typeof trackedArch>[] = [];
  // Captured while the body runs: destroyWorld detaches the storage from its world.
  const worlds: Storage["world"][] = [];
  const gen = throughputBench((storage) => {
    received.push(storage);
    worlds.push(storage.world);
  })();
  return {
    gen,
    received,
    isDestroyed: () => worlds[0]?.destroyed === true,
  };
}

/** Starts `frameBench` over a body that records the frame it is handed. */
function startFrame(): Started {
  const received: FrameCtx[] = [];
  const gen = frameBench((frame) => {
    received.push(frame);
  })();
  return {
    gen,
    received,
    isDestroyed: () => received[0]?.world.destroyed === true,
  };
}

const PAIRED_HELPERS = [
  { label: "throughputBench", start: startThroughput },
  { label: "frameBench", start: startFrame },
];

describe.each(PAIRED_HELPERS)("$label", ({ start }) => {
  it("runs the body once, untimed, before yielding it to mitata's batched timing", () => {
    const started = start();

    const first = started.gen.next();

    expect(started.received).toHaveLength(1);
    expect(first.value).toStrictEqual({ heap: false, bench: expect.any(Function) });
  });

  it("times the body over the same world the warmup ran over", () => {
    const started = start();
    const first = started.gen.next();

    if (!isTimedYield(first.value)) {
      throw new Error("the first yield is not a timedBench yield");
    }
    first.value.bench();

    expect(started.received).toHaveLength(2);
    expect(started.received[1]).toBe(started.received[0]);
  });

  it("destroys the world once mitata resumes it after timing", () => {
    const started = start();
    started.gen.next();

    const last = started.gen.next();

    expect(last.done).toBe(true);
    expect(started.isDestroyed()).toBe(true);
  });
});

describe("throughputBench", () => {
  it("hands the body the tracked storage of a world with no background entities", () => {
    const started = startThroughput();

    started.gen.next();

    const [storage] = started.received;
    if (!isTrackedStorage(storage)) {
      throw new Error("the body received no tracked storage");
    }
    const x = storage.columns.get(Position)?.["x"];
    const background = [...storage.world.storages.values()].find(
      (candidate) => candidate.archetype === bgArch,
    );
    expect(storage.archetype).toBe(trackedArch);
    expect(Array.from(x ?? []).slice(0, storage.n)).toStrictEqual(
      Array.from({ length: DEFAULT_N }, (_, row) => row + 1),
    );
    expect(background?.n).toBe(0);
  });
});

describe("frameBench", () => {
  it("hands the body a frame world holding DEFAULT_N entities in each of its nine storages", () => {
    const started = startFrame();

    started.gen.next();

    const [frame] = started.received;
    if (!isFrameCtx(frame)) {
      throw new Error("the body received no frame");
    }
    expect([...frame.world.storages.values()].map((storage) => storage.n)).toStrictEqual(
      Array.from({ length: 9 }, () => DEFAULT_N),
    );
  });
});

/** Narrows a generator's yielded value to the `timedBench` shape. */
function isTimedYield(value: unknown): value is { heap: false; bench: () => void } {
  return (
    typeof value === "object" &&
    value !== null &&
    "bench" in value &&
    typeof value.bench === "function"
  );
}

/** Narrows a recorded body argument to a storage of the tracked archetype. */
function isTrackedStorage(value: unknown): value is Storage<typeof trackedArch> {
  return (
    typeof value === "object" &&
    value !== null &&
    "archetype" in value &&
    value.archetype === trackedArch
  );
}

/** Narrows a recorded body argument to a frame from `makeFrameWorld`. */
function isFrameCtx(value: unknown): value is FrameCtx {
  return typeof value === "object" && value !== null && "world" in value && "soa10" in value;
}
