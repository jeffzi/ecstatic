import { each, register, type Storage } from "ecstatic";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import {
  bgArch,
  chainArch,
  Position,
  soa10Arch,
  soa1Arch,
  soa2Arch,
  soa5Arch,
  spawnArch,
  tagArch,
  trackedArch,
} from "../../benchmarks/archetypes.js";
import { DEFAULT_N, DT } from "../../benchmarks/helpers.js";
import { benchNames } from "../../benchmarks/runner.js";

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
// fused twin and one world from another.
vi.mock("ecstatic", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ecstatic")>();
  return { ...actual, each: vi.fn(actual.each), register: vi.fn(actual.register) };
});

const FRAME_ORDER = [
  trackedArch,
  bgArch,
  spawnArch,
  tagArch,
  chainArch,
  soa1Arch,
  soa2Arch,
  soa5Arch,
  soa10Arch,
];

const THROUGHPUT_WORLD = [trackedArch, bgArch];

/** The storage `register` returned for `arch` during the current benchmark run. */
function registeredStorage(arch: unknown): Storage {
  const index = vi.mocked(register).mock.calls.findIndex(([, candidate]) => candidate === arch);
  const result = vi.mocked(register).mock.results[index];
  if (result?.type !== "return") {
    throw new Error("no storage was registered for that archetype");
  }
  return result.value;
}

/** `storage`'s live values of one field, read from its column. */
function liveValues(storage: Storage, component: unknown, field: string): number[] {
  const columns = [...storage.columns].find(([descriptor]) => descriptor === component)?.[1];
  const column = columns?.[field];
  return Array.from(column ?? [], Number).slice(0, storage.n);
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
  const first: unknown = gen.next().value;
  if (!isTimedYield(first)) {
    throw new Error(`'${name}' did not yield a timedBench body`);
  }
  return first.bench;
}

/** The archetypes `body` hands to each(), in call order. */
function eachOrder(body: () => void): unknown[] {
  vi.mocked(each).mockClear();
  body();
  return vi
    .mocked(each)
    .mock.calls.map(([target]) => (isStorage(target) ? target.archetype : target));
}

/**
 * The archetypes whose columns `body` looks up, in first-lookup order, across the given storages.
 *
 * @param body - The timed body to run once.
 * @param storages - The storages whose column lookups are recorded.
 * @returns Each storage's archetype once, in the order `body` first read one of its columns.
 */
function columnReadOrder(body: () => void, storages: readonly Storage[]): unknown[] {
  const order: unknown[] = [];
  const spies = storages.map((storage) =>
    vi.spyOn(storage.columns, "get").mockImplementation(function (this: unknown, key) {
      if (order.at(-1) !== storage.archetype) {
        order.push(storage.archetype);
      }
      return Map.prototype.get.call(storage.columns, key);
    }),
  );
  body();
  for (const spy of spies) {
    spy.mockRestore();
  }
  return order;
}

beforeAll(async () => {
  await import("../../benchmarks/iteration-bench.js");
  await import("../../benchmarks/reference-bench.js");
});

afterEach(() => {
  vi.mocked(each).mockClear();
  vi.mocked(register).mockClear();
});

describe("registered benchmarks", () => {
  it("include the each() and fused twins under their documented names", () => {
    const names = benchNames();

    expect(names).toStrictEqual(
      expect.arrayContaining([
        "iteration/throughput",
        "iteration/post_churn_throughput",
        "iteration/frame",
        "reference/fused_throughput",
        "reference/fused_frame",
      ]),
    );
  });
});

describe.each([
  { name: "iteration/throughput", world: THROUGHPUT_WORLD, eachCalls: 1 },
  { name: "reference/fused_throughput", world: THROUGHPUT_WORLD, eachCalls: 0 },
  { name: "iteration/frame", world: FRAME_ORDER, eachCalls: 9 },
  { name: "reference/fused_frame", world: FRAME_ORDER, eachCalls: 0 },
])("$name", ({ name, world, eachCalls }) => {
  it("builds the same world as its twin", () => {
    startRegistered(name);

    const archetypes = vi.mocked(register).mock.calls.map(([, arch]) => arch);

    expect(archetypes).toStrictEqual(world);
  });

  it(`calls each() ${String(eachCalls)} times per timed pass`, () => {
    const body = startRegistered(name);

    const calls = eachOrder(body);

    expect(calls).toHaveLength(eachCalls);
  });
});

describe.each([{ name: "iteration/throughput" }, { name: "reference/fused_throughput" }])(
  "$name",
  ({ name }) => {
    it("advances Position exactly once before timing starts", () => {
      startRegistered(name);

      const x = liveValues(registeredStorage(trackedArch), Position, "x");

      expect(x).toStrictEqual(Array.from({ length: DEFAULT_N }, (_, row) => row + 1 + DT));
    });
  },
);

describe.each([{ name: "iteration/frame" }, { name: "reference/fused_frame" }])(
  "$name",
  ({ name }) => {
    it("advances the frame exactly once before timing starts", () => {
      startRegistered(name);

      const x = liveValues(registeredStorage(spawnArch), Position, "x");

      expect(x).toStrictEqual(Array.from({ length: DEFAULT_N }, () => DT));
    });
  },
);

describe("iteration/frame", () => {
  it("runs its nine each() systems in frame order", () => {
    const body = startRegistered("iteration/frame");

    const order = eachOrder(body);

    expect(order).toStrictEqual(FRAME_ORDER);
  });
});

describe("reference/fused_frame", () => {
  it("runs its nine fused systems in frame order", () => {
    const body = startRegistered("reference/fused_frame");
    const storages = FRAME_ORDER.map((arch) => registeredStorage(arch));

    const order = columnReadOrder(body, storages);

    expect(order).toStrictEqual(FRAME_ORDER);
  });
});

describe("iteration/post_churn_throughput", () => {
  it("times a churned world that has been integrated exactly once", () => {
    startRegistered("iteration/post_churn_throughput");

    const storage = registeredStorage(trackedArch);
    const x = liveValues(storage, Position, "x");
    const respawned = x.filter((value) => value === 0);
    const survivors = x.filter((value) => value !== 0);

    expect(storage.n).toBe(DEFAULT_N);
    expect(respawned.length).toBeGreaterThan(0);
    expect(survivors.every((value) => Object.is(Math.round(value) + DT, value))).toBe(true);
  });
});

/** Narrows a registered factory's return value to a generator. */
function isGenerator(value: unknown): value is Generator<unknown, unknown, unknown> {
  return typeof value === "object" && value !== null && "next" in value;
}

/** Narrows a generator's yielded value to the `timedBench` shape. */
function isTimedYield(value: unknown): value is { heap: false; bench: () => void } {
  return (
    typeof value === "object" &&
    value !== null &&
    "bench" in value &&
    typeof value.bench === "function"
  );
}

/** Narrows each()'s first argument to a single storage. */
function isStorage(value: unknown): value is Storage {
  return typeof value === "object" && value !== null && "archetype" in value;
}
