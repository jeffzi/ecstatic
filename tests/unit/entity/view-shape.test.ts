import { setFlagsFromString } from "node:v8";
import { runInThisContext } from "node:vm";

import { describe, expect, it } from "vitest";

import type { EachViewOf } from "../../../src/entity/each.js";
import {
  archetype,
  components,
  createWorld,
  each,
  query,
  register,
  spawn,
} from "../../../src/index.js";

// Every field in this file is a plain number (one column array kind), so the
// accessors' element loads stay monomorphic and only the column lookup can
// make an inline cache megamorphic.
const { ShapeA: A } = components({ ShapeA: { v: 0 } });
const { ShapeB: B } = components({ ShapeB: { v: 0 } });
const { ShapeC: C } = components({ ShapeC: { v: 0 } });
const { ShapeD: D } = components({ ShapeD: { v: 0 } });
const { ShapeE: E } = components({ ShapeE: { v: 0 } });
const { ShapePos: Pos } = components({ ShapePos: { x: 0, y: 0 } });
const { ShapeVel: Vel } = components({ ShapeVel: { vx: 0, vy: 0 } });
const { ShapeShield: Shield } = components({ ShapeShield: { hp: 5 } });
const { ShapeStunned: Stunned } = components({ ShapeStunned: {} });
const { ShapeWide: Wide } = components({ ShapeWide: { a: 1, b: 2, c: 3, d: 4, e: 5 } });
const { ShapePair: Pair } = components({ ShapePair: { a: 1, b: 2 } });

type ViewCallback = (view: object) => void;
type Iterate = (cb: ViewCallback) => void;

const SUPERSET_KEYS = "abcdefghij";

setFlagsFromString("--allow-natives-syntax");

/** Compiles a one-argument V8 intrinsic call; must run after the natives flag is set. */
function intrinsic(name: string): (arg: unknown) => unknown {
  const compiled: unknown = runInThisContext(`(arg) => %${name}(arg)`);
  if (typeof compiled !== "function") throw new Error(`could not compile %${name}`);
  return (arg) => Reflect.apply(compiled, undefined, [arg]);
}

const hasFastPropertiesIntrinsic = intrinsic("HasFastProperties");
const getFeedbackIntrinsic = intrinsic("GetFeedback");

/** True when `o` is in V8 fast-properties mode (not dictionary mode). */
function hasFastProperties(o: object): boolean {
  return hasFastPropertiesIntrinsic(o) === true;
}

/** JSON dump of the inline-cache states V8 recorded for `f`. */
function feedbackOf(f: unknown): string {
  return JSON.stringify(getFeedbackIntrinsic(f));
}

/** Builds a plain object from `{}` by adding each key in turn, as user code might. */
function plainObjectWithKeys(keys: string): Record<string, number> {
  const o: Record<string, number> = {};
  for (const key of keys) o[key] = 0;
  return o;
}

/** Visits every view through `iterate` and labels the views and field records in dictionary mode. */
function dictionaryModeObjects(iterate: Iterate): string[] {
  const slow = new Set<string>();
  iterate((view) => {
    const keys = Object.getOwnPropertyNames(view);
    if (!hasFastProperties(view)) slow.add(`view{${keys.join(",")}}`);
    for (const key of keys) {
      const value: unknown = Reflect.get(view, key);
      if (typeof value === "object" && value !== null && !hasFastProperties(value)) {
        slow.add(`${key}{${Object.getOwnPropertyNames(value).join(",")}}`);
      }
    }
  });
  return [...slow];
}

/** Collects the getter and setter of every accessor on `o`. */
function accessorFunctions(o: object): unknown[] {
  return Object.values(Object.getOwnPropertyDescriptors(o)).flatMap((descriptor) =>
    Object.entries(descriptor)
      .filter(([key, value]) => (key === "get" || key === "set") && value !== undefined)
      .map(([, value]): unknown => value),
  );
}

describe("view shape — fast properties", () => {
  it.each([
    {
      label: "five components sharing field v",
      setup: () => {
        const storage = register(createWorld(), archetype([A, B, C, D, E]));
        spawn(storage);
        spawn(storage);
        return (cb: ViewCallback) => {
          each(storage, cb);
        };
      },
    },
    {
      label: "views of several storages",
      setup: () => {
        const world = createWorld();
        const first = register(world, archetype([Pos]));
        const second = register(world, archetype([Vel]));
        spawn(first);
        spawn(second);
        return (cb: ViewCallback) => {
          each(first, cb);
          each(second, cb);
        };
      },
    },
    {
      label: "a component reused by a second storage",
      setup: () => {
        const world = createWorld();
        const first = register(world, archetype([Pos]));
        const second = register(world, archetype([Pos, Vel]));
        spawn(first);
        spawn(second);
        return (cb: ViewCallback) => {
          each([first, second], cb);
        };
      },
    },
    {
      label: "optional slots on several storages",
      setup: () => {
        const world = createWorld();
        const first = register(world, archetype([Pos], [Shield, Stunned]));
        const second = register(world, archetype([Vel], [Shield, Stunned]));
        spawn(first, { ShapeShield: { hp: 1 }, ShapeStunned: true });
        spawn(second, { ShapeShield: { hp: 2 } });
        return (cb: ViewCallback) => {
          each([first, second], cb);
        };
      },
    },
    {
      label: "query() across storages",
      setup: () => {
        const world = createWorld();
        spawn(register(world, archetype([Pos])));
        spawn(register(world, archetype([Pos, Vel])));
        return (cb: ViewCallback) => {
          query(world, [Pos], cb);
        };
      },
    },
    {
      label: "a superset-key object made first",
      setup: () => {
        plainObjectWithKeys(SUPERSET_KEYS);
        const storage = register(createWorld(), archetype([Wide, Pair]));
        spawn(storage);
        return (cb: ViewCallback) => {
          each(storage, cb);
        };
      },
    },
    {
      label: "a superset-key object made last",
      setup: () => {
        const storage = register(createWorld(), archetype([Wide, Pair]));
        spawn(storage);
        plainObjectWithKeys(SUPERSET_KEYS);
        return (cb: ViewCallback) => {
          each(storage, cb);
        };
      },
    },
  ])("keeps views and field records in fast mode with $label", ({ setup }) => {
    const iterate = setup();

    const slow = dictionaryModeObjects(iterate);

    expect(slow).toStrictEqual([]);
  });
});

describe("view shape — field access independent of unrelated objects", () => {
  it("keeps field accessor inline caches out of the megamorphic state", () => {
    const keep = plainObjectWithKeys(SUPERSET_KEYS);
    const storage = register(createWorld(), archetype([Wide, Pair]));
    spawn(storage);
    spawn(storage);
    const records = new Set<object>();
    each(storage, (e) => {
      records.add(e.ShapeWide).add(e.ShapePair);
    });
    const accessors = [...records].flatMap(accessorFunctions);
    // A callback held in a variable keeps the runtime call, so the accessors under test run.
    const cb = (e: EachViewOf<typeof storage>): void => {
      e.ShapeWide.a +=
        e.ShapeWide.b + e.ShapeWide.c + e.ShapeWide.d + e.ShapeWide.e + (keep["j"] ?? 0);
      e.ShapePair.a += e.ShapePair.b;
    };

    for (let pass = 0; pass < 200; pass++) {
      each(storage, cb);
    }

    // Seven fields (five on Wide, two on Pair), each with a getter and a setter.
    expect(accessors).toHaveLength(14);
    expect(accessors.map(feedbackOf).filter((fb) => fb.includes("MEGAMORPHIC"))).toStrictEqual([]);
  });
});
