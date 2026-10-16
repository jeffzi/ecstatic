import { each, register, type Storage } from "ecstatic";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { Position, spawnArch, trackedArch } from "../../benchmarks/archetypes.js";
import { DEFAULT_N, DT } from "../../benchmarks/helpers.js";
import { firstTimedBody, FRAME_ARCHETYPES, isStorage, liveValues } from "./fixtures.js";

const registered = vi.hoisted(() => new Map<string, () => unknown>());

// mitata is the boundary: capturing what the suites hand it is how a test reaches the generator
// registered under a name.
vi.mock("mitata", async (importOriginal) => {
  const actual = await importOriginal<typeof import("mitata")>();
  return {
    ...actual,
    bench: (name: string, body: () => unknown) => {
      registered.set(name, body);
    },
  };
});

// Real each() and register(), recorded: which storages a timed body iterates through each(), and
// which archetypes a benchmark's world registers, are what tells an each() benchmark from its
// inlined twin and one world from another.
vi.mock("ecstatic", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ecstatic")>();
  return { ...actual, each: vi.fn(actual.each), register: vi.fn(actual.register) };
});

const registerMock = vi.mocked(register);
const eachMock = vi.mocked(each);

/** The storage `register` most recently returned for `arch`. */
function registeredStorage(arch: unknown): Storage {
  const index = registerMock.mock.calls.findLastIndex(([, candidate]) => candidate === arch);
  const result = registerMock.mock.results[index];
  if (result?.type !== "return") {
    throw new Error("no storage was registered for that archetype");
  }
  return result.value;
}

/** Runs the generator registered as `name` up to its first yield and returns the timed body. */
function startRegistered(name: string): () => void {
  const factory = registered.get(name);
  if (factory === undefined) {
    throw new Error(`no benchmark registered as '${name}'`);
  }
  const gen = factory();
  if (!isGenerator(gen)) {
    throw new Error(`'${name}' is not a generator benchmark`);
  }
  return firstTimedBody(gen);
}

/** Each storage's archetype and population in the world benchmark `name` builds, read through the storage registered for `anchor`. */
function builtPopulations(name: string, anchor: unknown): Map<unknown, number> {
  startRegistered(name);
  return new Map(
    [...registeredStorage(anchor).world.storages.values()].map(
      (storage) => [storage.archetype, storage.n] as const,
    ),
  );
}

/** The archetypes `body` hands to each(), in call order. */
function eachTargets(body: () => void): unknown[] {
  eachMock.mockClear();
  body();
  return eachMock.mock.calls.map(([target]) => (isStorage(target) ? target.archetype : target));
}

beforeAll(async () => {
  await import("../../benchmarks/iteration-bench.js");
  await import("../../benchmarks/reference-bench.js");
});

afterEach(() => {
  eachMock.mockClear();
  registerMock.mockClear();
});

/** What a twin benchmark must iterate through each(), and the storage whose Position its timed pass advances. */
interface TwinExpectation {
  name: string;
  eachTargets: readonly unknown[];
  advancedLabel: string;
  advancedArch: unknown;
}

const THROUGHPUT_TWIN = { advancedLabel: "tracked", advancedArch: trackedArch };

const FRAME_TWIN = { advancedLabel: "spawn", advancedArch: spawnArch };

const TWINS: TwinExpectation[] = [
  { name: "iteration/throughput", ...THROUGHPUT_TWIN, eachTargets: [trackedArch] },
  { name: "reference/inlined_throughput", ...THROUGHPUT_TWIN, eachTargets: [] },
  { name: "iteration/frame", ...FRAME_TWIN, eachTargets: FRAME_ARCHETYPES },
  { name: "reference/inlined_frame", ...FRAME_TWIN, eachTargets: [] },
];

describe.each(TWINS)("$name", (expected) => {
  it(`hands each() ${String(expected.eachTargets.length)} targets per timed pass`, () => {
    const body = startRegistered(expected.name);

    const targets = eachTargets(body);

    expect(targets).toHaveLength(expected.eachTargets.length);
    expect(new Set(targets)).toStrictEqual(new Set(expected.eachTargets));
  });

  it(`times a pass that advances ${expected.advancedLabel} Position x by one step`, () => {
    const body = startRegistered(expected.name);
    const storage = registeredStorage(expected.advancedArch);
    const before = liveValues(storage, Position, "x");

    body();

    expect(liveValues(storage, Position, "x")).toStrictEqual(before.map((x) => x + DT));
  });
});

const TWIN_PAIRS = [
  {
    eachName: "iteration/throughput",
    inlinedName: "reference/inlined_throughput",
    anchor: trackedArch,
  },
  { eachName: "iteration/frame", inlinedName: "reference/inlined_frame", anchor: spawnArch },
];

describe.each(TWIN_PAIRS)("$eachName and $inlinedName", ({ eachName, inlinedName, anchor }) => {
  it("build worlds with the same storages and populations", () => {
    const viaEach = builtPopulations(eachName, anchor);
    const viaInlined = builtPopulations(inlinedName, anchor);

    expect(viaInlined).toStrictEqual(viaEach);
  });
});

describe("iteration/post_churn_throughput", () => {
  it("times one integration pass over a churned world", () => {
    const body = startRegistered("iteration/post_churn_throughput");
    const storage = registeredStorage(trackedArch);
    const before = liveValues(storage, Position, "x");
    const respawned = before.filter((x) => x === 0);

    body();

    expect(storage.n).toBe(DEFAULT_N);
    expect(respawned.length).toBeGreaterThan(0);
    // Respawned entities carry the default zero Velocity, so the pass leaves them at 0.
    expect(liveValues(storage, Position, "x")).toStrictEqual(
      before.map((x) => (x === 0 ? 0 : x + DT)),
    );
  });
});

/** Narrows a registered factory's return value to a generator. */
function isGenerator(value: unknown): value is Generator<unknown, unknown, unknown> {
  return typeof value === "object" && value !== null && "next" in value;
}
