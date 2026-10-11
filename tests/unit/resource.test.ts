import { assert, describe, expect, it } from "vitest";

import {
  component,
  createWorld,
  destroyWorld,
  getResource,
  resetResource,
  setResource,
} from "../../src/index.js";
import { getResourceMeta, resource } from "../../src/resource.js";

/** Message of the error `fn` throws; throws itself when `fn` completes. */
function messageOfThrow(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("expected the call to throw, but it returned");
}

describe("resource", () => {
  it("returns unique numeric IDs", () => {
    const A = resource("ResourceTestA", { val: 0 });
    const B = resource("ResourceTestB", { flag: false });

    expect(typeof A).toBe("number");
    expect(A).not.toBe(B);
  });

  it("stores name, byte-order sorted fields, and defaults in metadata", () => {
    const Input = resource("ResourceTestInput", { fire: false, moveY: 0, moveX: 0 });

    const meta = getResourceMeta(Input);

    expect(meta.name).toBe("ResourceTestInput");
    expect(meta.fields).toStrictEqual(["fire", "moveX", "moveY"]);
    expect(meta.defaults).toStrictEqual({ fire: false, moveY: 0, moveX: 0 });
  });

  it("throws on re-registration with a different shape", () => {
    resource("ResourceTestDuplicate", { value: 0 });

    expect(() => resource("ResourceTestDuplicate", { count: 1 })).toThrow(
      "resource shape conflict: ResourceTestDuplicate",
    );
  });

  it("throws when metadata is requested for an unregistered ID", () => {
    expect(() => getResourceMeta(-1)).toThrow("unknown resource ID: -1");
  });

  it("keeps its own namespace, separate from components", () => {
    component("ResourceTestSharedName");

    expect(() => resource("ResourceTestSharedName", { value: 0 })).not.toThrow();
  });

  it("snapshots defaults at registration so later mutation of the caller's object is inert", () => {
    const defaults = { hp: 1, pos: { x: 1 } };
    const Vitals = resource("ResourceTestRegistrationSnapshot", defaults);

    defaults.hp = 5;
    defaults.pos.x = 5;

    expect(getResource(createWorld(), Vitals)).toStrictEqual({ hp: 1, pos: { x: 1 } });
  });

  describe("field name validation", () => {
    it.each([
      { label: "starting with a digit", field: "1field" },
      { label: "containing a hyphen", field: "field-name" },
      { label: "containing a space", field: "field name" },
      { label: "with non-ASCII characters", field: "café" },
    ])("rejects a field name $label", ({ field, label }) => {
      const name = `ResourceTestFieldValidation_${label.replaceAll(" ", "_")}`;

      expect(() => resource(name, { [field]: 0 })).toThrow("must be a valid ASCII identifier");
    });

    it("names the resource and the offending field in the error", () => {
      const message = messageOfThrow(() =>
        resource("ResourceTestFieldMessage", { "bad-field": 0 }),
      );

      expect(message).toContain("bad-field");
      expect(message).toContain("ResourceTestFieldMessage");
      expect(message).toContain("resource");
    });

    it("accepts field names starting with a letter or underscore", () => {
      expect(() =>
        resource("ResourceTestFieldValidation_valid", {
          field: 0,
          _field: 0,
          Field1_name: 0,
          Field: 0,
        }),
      ).not.toThrow();
    });
  });

  describe("idempotent registration", () => {
    class IdempotentLogger {
      lines: string[] = [];
    }
    const sharedLogger = new IdempotentLogger();
    const sharedHandler = () => 42;

    it.each([
      {
        label: "equal primitive defaults",
        name: "IdempotentPrimitive",
        defaults: { x: 1, y: "hello", z: true },
      },
      {
        label: "nested records by content",
        name: "IdempotentNested",
        defaults: { pos: { x: 0, y: 0 } },
      },
      {
        label: "arrays, Date, Map, and Set by content",
        name: "IdempotentContainers",
        defaults: {
          items: [1, 2],
          when: new Date(1000),
          byId: new Map([["a", 1]]),
          seen: new Set([1, 2]),
        },
      },
      {
        label: "functions by identity",
        name: "IdempotentFunc",
        defaults: { handler: sharedHandler },
      },
      {
        label: "class instances by identity",
        name: "IdempotentInstance",
        defaults: { logger: sharedLogger },
      },
    ])("matches $label", ({ name, defaults }) => {
      const id1 = resource(name, defaults);
      const id2 = resource(name, defaults);

      expect(id2).toBe(id1);
    });

    it("preserves existing world data through a second declaration", () => {
      const id1 = resource("IdempotentWorld", { value: 42 });
      const world = createWorld();
      setResource(world, id1, { value: 100 });

      const id2 = resource("IdempotentWorld", { value: 42 });

      expect(id2).toBe(id1);
      expect(getResource(world, id2).value).toBe(100);
    });
  });

  describe("shape conflict", () => {
    class ConflictLogger {
      lines: string[] = [];
    }

    it.each([
      { label: "field names differ", name: "ConflictFields", first: { x: 1 }, second: { y: 1 } },
      {
        label: "default values differ",
        name: "ConflictValues",
        first: { x: 1 },
        second: { x: 2 },
      },
      {
        label: "functions differ by identity",
        name: "ConflictFunc",
        first: { handler: () => 42 },
        second: { handler: () => 42 },
      },
      {
        label: "class instances differ by identity",
        name: "ConflictInstance",
        first: { logger: new ConflictLogger() },
        second: { logger: new ConflictLogger() },
      },
      {
        label: "array length differs",
        name: "ConflictArrayLength",
        first: { items: [1, 2] },
        second: { items: [1] },
      },
      {
        label: "array elements differ",
        name: "ConflictArrayElements",
        first: { items: [1, 2] },
        second: { items: [1, 3] },
      },
      {
        label: "Map size differs",
        name: "ConflictMapSize",
        first: { m: new Map([["a", 1]]) },
        second: {
          m: new Map([
            ["a", 1],
            ["b", 2],
          ]),
        },
      },
      {
        label: "Map values differ",
        name: "ConflictMapValues",
        first: { m: new Map([["a", 1]]) },
        second: { m: new Map([["a", 2]]) },
      },
      {
        label: "Set size differs",
        name: "ConflictSetSize",
        first: { s: new Set([1]) },
        second: { s: new Set([1, 2]) },
      },
      {
        label: "Set members differ",
        name: "ConflictSetMembers",
        first: { s: new Set([1]) },
        second: { s: new Set([2]) },
      },
      {
        label: "array vs Date",
        name: "ConflictCrossType_array_vs_Date",
        first: { x: [1] },
        second: { x: new Date(0) },
      },
      {
        label: "Date vs array",
        name: "ConflictCrossType_Date_vs_array",
        first: { x: new Date(0) },
        second: { x: [1] },
      },
      {
        label: "record vs Date",
        name: "ConflictCrossType_record_vs_Date",
        first: { x: { a: 1 } },
        second: { x: new Date(0) },
      },
      {
        label: "record vs Map",
        name: "ConflictCrossType_record_vs_Map",
        first: { x: { a: 1 } },
        second: { x: new Map([["a", 1]]) },
      },
      {
        label: "record vs Set",
        name: "ConflictCrossType_record_vs_Set",
        first: { x: { a: 1 } },
        second: { x: new Set([1]) },
      },
      {
        label: "Date vs record",
        name: "ConflictCrossType_Date_vs_record",
        first: { x: new Date(0) },
        second: { x: { a: 1 } },
      },
      {
        label: "Map vs record",
        name: "ConflictCrossType_Map_vs_record",
        first: { x: new Map([["a", 1]]) },
        second: { x: { a: 1 } },
      },
      {
        label: "Set vs record",
        name: "ConflictCrossType_Set_vs_record",
        first: { x: new Set([1]) },
        second: { x: { a: 1 } },
      },
      {
        label: "record key count differs",
        name: "ConflictCrossType_record_key_count_differs",
        first: { x: { a: 1 } },
        second: { x: { a: 1, b: 2 } },
      },
    ])("throws on shape conflict: $label", ({ name, first, second }) => {
      resource(name, first);

      expect(() => resource(name, second)).toThrow(`resource shape conflict: ${name}`);
    });

    it("leaves the original registration intact", () => {
      const original = resource("ConflictIntact", { value: 42 });
      const metaBefore = getResourceMeta(original);

      expect(() => resource("ConflictIntact", { other: 99 })).toThrow(
        "resource shape conflict: ConflictIntact",
      );

      expect(getResourceMeta(original)).toStrictEqual(metaBefore);
    });
  });
});

describe("getResource", () => {
  const Score = resource("ResourceTestScore", { value: 0, combo: 1 });

  it("lazy-initializes from defaults on first access", () => {
    const world = createWorld();

    expect(getResource(world, Score)).toStrictEqual({ value: 0, combo: 1 });
  });

  it("returns the same reference on repeated access", () => {
    const world = createWorld();

    const first = getResource(world, Score);
    const second = getResource(world, Score);

    expect(second).toBe(first);
  });

  it("keeps two worlds independent", () => {
    const w1 = createWorld();
    const w2 = createWorld();

    setResource(w1, Score, { value: 100 });

    expect(getResource(w1, Score).value).toBe(100);
    expect(getResource(w2, Score).value).toBe(0);
  });

  it("deep-clones nested object defaults per world", () => {
    const Settings = resource("ResourceTestNestedDefaults", { ui: { scale: 1, contrast: 2 } });
    const w1 = createWorld();
    const w2 = createWorld();

    getResource(w1, Settings).ui.scale = 3;

    expect(getResource(w1, Settings).ui.scale).toBe(3);
    expect(getResource(w2, Settings).ui.scale).toBe(1);
  });

  it("clones container defaults per world instead of sharing them", () => {
    const Bag = resource("ResourceTestContainerDefaults", {
      items: [1],
      nested: { tags: ["a"] },
      when: new Date(0),
      byId: new Map([["a", 1]]),
      seen: new Set([1]),
    });
    const w1 = createWorld();
    const w2 = createWorld();

    const first = getResource(w1, Bag);
    first.items.push(2);
    first.nested.tags.push("b");
    first.when.setTime(1000);
    first.byId.set("b", 2);
    first.seen.add(2);

    const second = getResource(w2, Bag);
    expect(second.items).toStrictEqual([1]);
    expect(second.nested.tags).toStrictEqual(["a"]);
    expect(second.when.getTime()).toBe(0);
    expect(second.byId.size).toBe(1);
    expect(second.seen.size).toBe(1);
  });

  it("shares objects held as Set members across worlds", () => {
    const member = { hits: 0 };
    const Bag = resource("ResourceTestSetMemberSharing", { seen: new Set([member]) });
    const w1 = createWorld();
    const w2 = createWorld();

    expect([...getResource(w1, Bag).seen][0]).toBe(member);
    expect([...getResource(w2, Bag).seen][0]).toBe(member);
  });

  it("shares objects used as Map keys across worlds", () => {
    const key = { id: 1 };
    const Index = resource("ResourceTestMapKeySharing", { byKey: new Map([[key, 1]]) });
    const w1 = createWorld();
    const w2 = createWorld();

    expect([...getResource(w1, Index).byKey.keys()][0]).toBe(key);
    expect([...getResource(w2, Index).byKey.keys()][0]).toBe(key);
  });

  it("isolates objects held in array defaults per world", () => {
    const item = { hp: 1 };
    const Bag = resource("ResourceTestArrayItemIsolation", { items: [item] });
    const w1 = createWorld();
    const w2 = createWorld();

    const firstItem = getResource(w1, Bag).items[0];
    assert(firstItem != null);
    firstItem.hp = 9;

    expect(getResource(w2, Bag).items[0]?.hp).toBe(1);
    expect(item.hp).toBe(1);
  });

  it("shares class instances by reference", () => {
    class Logger {
      lines: string[] = [];
    }
    const shared = new Logger();
    const Log = resource("ResourceTestClassInstance", { logger: shared });
    const w1 = createWorld();
    const w2 = createWorld();

    expect(getResource(w1, Log).logger).toBe(shared);
    expect(getResource(w2, Log).logger).toBe(shared);
  });

  it("keeps registered defaults intact when a world's data is mutated", () => {
    const Bag = resource("ResourceTestDefaultsIntact", { items: [1] });
    const world = createWorld();

    getResource(world, Bag).items.push(2);

    expect(getResourceMeta(Bag).defaults["items"]).toStrictEqual([1]);
  });
});

describe("setResource", () => {
  const Score = resource("ResourceTestSetScore", { value: 0, combo: 1 });

  it("merges listed fields and keeps unlisted ones", () => {
    const world = createWorld();

    setResource(world, Score, { value: 42 });

    expect(getResource(world, Score)).toStrictEqual({ value: 42, combo: 1 });
  });

  it("overwrites every field when all are listed", () => {
    const world = createWorld();

    setResource(world, Score, { value: 10, combo: 5 });

    expect(getResource(world, Score)).toStrictEqual({ value: 10, combo: 5 });
  });

  it("clones caller-owned objects on write", () => {
    const Settings = resource("ResourceTestCloneOnSet", { ui: { scale: 1, contrast: 2 } });
    const world = createWorld();
    const shared = { scale: 5, contrast: 9 };

    setResource(world, Settings, { ui: shared });
    shared.scale = 12;

    expect(getResource(world, Settings).ui.scale).toBe(5);
  });

  it("writes only the values object's own keys", () => {
    class ScoreValues {
      value = 7;
    }
    // Enumerable but inherited: `for...in` walks it, `Object.hasOwn` rejects it.
    Object.defineProperty(ScoreValues.prototype, "combo", { enumerable: true, value: 99 });
    const world = createWorld();

    setResource(world, Score, new ScoreValues());

    expect(getResource(world, Score)).toStrictEqual({ value: 7, combo: 1 });
  });

  it("clones caller-owned containers on write", () => {
    const Bag = resource("ResourceTestCloneContainerOnSet", { items: [0] });
    const world = createWorld();
    const shared = [1];

    setResource(world, Bag, { items: shared });
    shared.push(2);

    expect(getResource(world, Bag).items).toStrictEqual([1]);
  });
});

describe("resetResource", () => {
  const Score = resource("ResourceTestResetScore", { value: 0, combo: 1 });

  it("restores every field to its default", () => {
    const world = createWorld();
    setResource(world, Score, { value: 99, combo: 10 });

    resetResource(world, Score);

    expect(getResource(world, Score)).toStrictEqual({ value: 0, combo: 1 });
  });

  it("initializes a never-accessed resource to defaults", () => {
    const world = createWorld();

    resetResource(world, Score);

    expect(getResource(world, Score)).toStrictEqual({ value: 0, combo: 1 });
  });

  it("reuses the live data object", () => {
    const world = createWorld();
    const before = getResource(world, Score);

    resetResource(world, Score);

    expect(getResource(world, Score)).toBe(before);
  });

  it("re-clones object defaults so worlds never alias", () => {
    const Config = resource("ResourceTestResetClone", { opts: { x: 1 } });
    const w1 = createWorld();
    const w2 = createWorld();

    resetResource(w1, Config);
    resetResource(w2, Config);
    getResource(w1, Config).opts.x = 99;

    expect(getResource(w2, Config).opts.x).toBe(1);
  });

  it("re-clones container defaults so worlds never alias", () => {
    const Config = resource("ResourceTestResetContainerClone", { items: [1] });
    const w1 = createWorld();
    const w2 = createWorld();

    resetResource(w1, Config);
    resetResource(w2, Config);
    getResource(w1, Config).items.push(99);

    expect(getResource(w2, Config).items).toStrictEqual([1]);
  });
});

describe("destroyWorld", () => {
  it("drops resource data so defaults are seen again", () => {
    const Score = resource("ResourceTestDestroy", { value: 0 });
    const world = createWorld();
    setResource(world, Score, { value: 7 });

    destroyWorld(world);

    expect(getResource(world, Score).value).toBe(0);
  });
});
