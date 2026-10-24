import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

import { each, register, type Storage, type World } from "ecstatic";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Position, spawnArch, trackedArch, Velocity } from "../../benchmarks/archetypes.js";
import { DEFAULT_N, DT } from "../../benchmarks/helpers.js";
import { FRAME_ARCHETYPES, isStorage, liveValues, setLiveValues } from "./fixtures.js";

/** The description each benchmark registered, by name. */
const registered = vi.hoisted(() => new Map<string, unknown>());

// Registration is the boundary: capturing the description each suite hands registerBench is how a
// test reaches the build and body registered under a name.
vi.mock("../../benchmarks/runner.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../benchmarks/runner.js")>();
  return {
    ...actual,
    registerBench: (...args: Parameters<typeof actual.registerBench>) => {
      const [name, description] = args;
      registered.set(name, description);
      actual.registerBench(...args);
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

/** Every description `warmedBench` and `manualBench` returned while the suites registered. */
const timingHelperResults = vi.hoisted(() => new Set<unknown>());

// The suites' timing helpers are what the timing tests pin, so a registration that times its body
// any other way escapes them: recording what the helpers return tells each registration's route.
vi.mock("../../benchmarks/helpers.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../benchmarks/helpers.js")>();
  const recording =
    <A extends unknown[], R>(make: (...args: A) => R) =>
    (...args: A): R => {
      const description = make(...args);
      timingHelperResults.add(description);
      return description;
    };
  return {
    ...actual,
    warmedBench: recording(actual.warmedBench),
    manualBench: recording(actual.manualBench),
  };
});

const registerMock = vi.mocked(register);
const eachMock = vi.mocked(each);

/**
 * A registered benchmark as a test drives it: its timing kind, a build that makes a world, and a
 * body over it.
 */
interface Description {
  kind: unknown;
  build: () => { world: World };
  body: (ctx: unknown) => void;
}

/** Narrows a registered value to a kind, a build, and a body. */
function isDescription(value: unknown): value is Description {
  return (
    typeof value === "object" &&
    value !== null &&
    "kind" in value &&
    "build" in value &&
    typeof value.build === "function" &&
    "body" in value &&
    typeof value.body === "function"
  );
}

/** The storage `register` most recently returned for `arch`. */
function registeredStorage(arch: unknown): Storage {
  const index = registerMock.mock.calls.findLastIndex(([, candidate]) => candidate === arch);
  const result = registerMock.mock.results[index];
  if (result?.type !== "return") {
    throw new Error("no storage was registered for that archetype");
  }
  return result.value;
}

/** The description the benchmark registered as `name`; throws when there is none. */
function registeredDescription(name: string): Description {
  const description = registered.get(name);
  if (!isDescription(description)) {
    throw new Error(`no benchmark description registered as '${name}'`);
  }
  return description;
}

/** Builds the world of the benchmark registered as `name` and returns one timed call of its body. */
function startRegistered(name: string): () => void {
  const { build, body } = registeredDescription(name);
  const ctx = build();
  return () => {
    body(ctx);
  };
}

/** The arguments of each each() call `body` makes, in call order. */
function eachCalls(body: () => void): typeof eachMock.mock.calls {
  eachMock.mockClear();
  body();
  return eachMock.mock.calls;
}

/** The callbacks `body` hands to each(), in call order. */
function eachCallbacks(body: () => void): unknown[] {
  return eachCalls(body).map(([, callback]) => callback);
}

/** Each storage's archetype and population in the world benchmark `name` builds. */
function builtPopulations(name: string): Map<unknown, number> {
  const { world } = registeredDescription(name).build();
  return new Map(
    [...world.storages.values()].map((storage) => [storage.archetype, storage.n] as const),
  );
}

/** The archetypes `body` hands to each(), in call order. */
function eachTargets(body: () => void): unknown[] {
  return eachCalls(body).map(([target]) => (isStorage(target) ? target.archetype : target));
}

/** Every suite's `sinkValue`, which reads what its read-only bodies have added so far. */
const SINK_VALUES = [
  (await import("../../benchmarks/access-bench.js")).sinkValue,
  (await import("../../benchmarks/entity-bench.js")).sinkValue,
  (await import("../../benchmarks/iteration-bench.js")).sinkValue,
  (await import("../../benchmarks/many-bench.js")).sinkValue,
];
await import("../../benchmarks/reference-bench.js");

/** Every registered benchmark name, in registration order. */
const REGISTERED_NAMES = [...registered.keys()];

/** The sum of every suite's sink. */
function sinkTotal(): number {
  return SINK_VALUES.reduce((sum, sinkValue) => sum + sinkValue(), 0);
}

/**
 * Gives every live Velocity a distinct value per row, so a body that reads velocities adds a sum no
 * other combination of its reads can cancel; the built world's `dx: 1, dy: -1` sums to zero.
 */
function varyVelocities(world: World): void {
  for (const storage of world.storages.values()) {
    if (!storage.columns.has(Velocity)) continue;
    const rows = Array.from({ length: storage.n }, (_, row) => row);
    setLiveValues(
      storage,
      Velocity,
      "dx",
      rows.map((row) => (row % 7) + 1),
    );
    setLiveValues(
      storage,
      Velocity,
      "dy",
      rows.map((row) => -(row % 5) - 3),
    );
  }
}

/** Each storage's population, in world order. */
function populations(world: World): number[] {
  return [...world.storages.values()].map((storage) => storage.n);
}

/** A row-weighted checksum of every live value in `storage`. */
function storageChecksum(storage: Storage): number {
  let checksum = 0;
  for (const fields of storage.columns.values()) {
    for (const column of Object.values(fields)) {
      for (let row = 0; row < storage.n; row++) checksum += (row + 1) * Number(column[row]);
    }
  }
  return checksum;
}

/** Each storage's population and a row-weighted checksum of every live value, in world order. */
function worldDigest(world: World): [number, number][] {
  return [...world.storages.values()].map((storage) => [storage.n, storageChecksum(storage)]);
}

afterEach(() => {
  eachMock.mockClear();
  registerMock.mockClear();
});

describe("every registered benchmark", () => {
  it.each(REGISTERED_NAMES)(
    "%s registers a description warmedBench or manualBench made",
    (name) => {
      const description = registered.get(name);

      expect(timingHelperResults.has(description)).toBe(true);
    },
  );

  it.each(REGISTERED_NAMES)(
    "%s is timed warmed exactly when one call leaves every storage's population as built",
    (name) => {
      const { kind, build, body } = registeredDescription(name);
      const ctx = build();
      const built = populations(ctx.world);

      body(ctx);

      expect(kind).toBe(isDeepStrictEqual(populations(ctx.world), built) ? "warmed" : "manual");
    },
  );

  it.each(REGISTERED_NAMES)("%s builds the recorded world", (name) => {
    const { build } = registeredDescription(name);

    const ctx = build();

    expect(worldDigest(ctx.world)).toMatchSnapshot("built world");
  });

  it.each(REGISTERED_NAMES)("%s has the recorded effect in one timed call", (name) => {
    const { build, body } = registeredDescription(name);
    const ctx = build();
    varyVelocities(ctx.world);
    const sinkBefore = sinkTotal();

    body(ctx);

    expect({ after: worldDigest(ctx.world), sank: sinkTotal() - sinkBefore }).toMatchSnapshot(
      "effect",
    );
  });
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
  { eachName: "iteration/throughput", inlinedName: "reference/inlined_throughput" },
  { eachName: "iteration/frame", inlinedName: "reference/inlined_frame" },
];

describe.each(TWIN_PAIRS)("$eachName and $inlinedName", ({ eachName, inlinedName }) => {
  it("build worlds with the same storages, populations, and contents", () => {
    const viaEach = registeredDescription(eachName).build().world;
    const viaInlined = registeredDescription(inlinedName).build().world;

    expect(builtPopulations(inlinedName)).toStrictEqual(builtPopulations(eachName));
    expect(worldDigest(viaInlined)).toStrictEqual(worldDigest(viaEach));
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

const ITERATION_BENCH = fileURLToPath(
  new URL("../../benchmarks/iteration-bench.ts", import.meta.url),
);
const ITERATION_SPEC = fileURLToPath(
  new URL("../../docs/benchmarks/specifications/iteration.md", import.meta.url),
);

/** The section of a benchmark spec headed `## name`, up to the rule that closes it. */
function specSection(spec: string, name: string): string {
  const start = spec.indexOf(`\n## ${name}\n`);
  if (start === -1) {
    throw new Error(`the spec has no section headed '${name}'`);
  }
  const end = spec.indexOf("\n---\n", start);
  return spec.slice(start, end === -1 ? undefined : end);
}

/** The bold labels and table properties a spec section lays out, in order. */
function sectionShape(section: string): string[] {
  return [...section.matchAll(/^(?:\*\*(\w+):\*\*|\| (\w+) +\|)/gm)].map(([, label, property]) =>
    String(label ?? property),
  );
}

describe("iteration/helper_call", () => {
  it("hands each() the tracked storage once per timed pass", () => {
    const body = startRegistered("iteration/helper_call");

    const targets = eachTargets(body);

    expect(targets).toStrictEqual([trackedArch]);
  });

  it("hands each() a callback that calls the module-level advance, which makes the body hazard-bearing", () => {
    const body = startRegistered("iteration/helper_call");

    const source = String(eachCallbacks(body)[0]);

    const callee = /(?<![\w$.])([A-Za-z_$][\w$]*)\s*\(/.exec(source)?.[1];
    expect({
      callee,
      declaredInside: /\b(?:function|const|let|var)\s+advance\b/.test(source),
      declaredAtModuleLevel: /^function advance\(/m.test(readFileSync(ITERATION_BENCH, "utf8")),
    }).toStrictEqual({ callee: "advance", declaredInside: false, declaredAtModuleLevel: true });
  });

  it("times a pass that advances every tracked Position x by its Velocity dx times DT", () => {
    const body = startRegistered("iteration/helper_call");
    const storage = registeredStorage(trackedArch);
    const dx = Array.from({ length: storage.n }, (_, row) => row + 2);
    setLiveValues(storage, Velocity, "dx", dx);
    const before = liveValues(storage, Position, "x");

    body();

    expect(liveValues(storage, Position, "x")).toStrictEqual(
      before.map((x, row) => x + Number(dx[row]) * DT),
    );
  });

  it("builds the world iteration/throughput builds", () => {
    const viaHelper = builtPopulations("iteration/helper_call");
    const viaThroughput = builtPopulations("iteration/throughput");

    expect(viaHelper).toStrictEqual(viaThroughput);
  });

  describe("spec section", () => {
    const spec = readFileSync(ITERATION_SPEC, "utf8");

    it("is listed in the iteration spec's index", () => {
      expect(spec).toContain("\n- [helper_call](#helper_call)\n");
    });

    it("lays out the same labels and properties as throughput's", () => {
      const shape = sectionShape(specSection(spec, "helper_call"));

      expect(shape).toStrictEqual(sectionShape(specSection(spec, "throughput")));
    });

    it("says the helper call makes the body hazard-bearing", () => {
      const section = specSection(spec, "helper_call");

      expect(section).toMatch(/call[^.]*makes (?:this|the) body hazard-bearing/);
    });
  });
});
