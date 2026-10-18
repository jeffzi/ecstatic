import { assert, describe, expect, it } from "vitest";

import { resolveFilter, TRIVIAL_MATCHER } from "../../src/filter.js";
import {
  archetype,
  component,
  components,
  createWorld,
  despawn,
  each,
  ref,
  register,
  spawn,
  spawnMany,
} from "../../src/index.js";
import { type Matcher, matcherFor } from "../../src/matcher.js";

const {
  ContractPosition: Position,
  ContractMarked: Marked,
  ContractShield: Shield,
  ContractStunned: Stunned,
  ContractOnFire: OnFire,
  ContractCargo: Cargo,
  ContractAbsent: Absent,
} = components({
  ContractPosition: { x: 0, y: 0 },
  ContractMarked: {},
  ContractShield: { hp: 0 },
  ContractStunned: {},
  ContractOnFire: {},
  ContractCargo: { weight: 0, owner: ref() },
  ContractAbsent: {},
});
const Pair = component("Contract A,B", { n: 0 });

const Ship = archetype([Position, Marked, Pair], [Shield, Stunned, OnFire]);

/** A fresh world holding one registered storage of the `Ship` archetype. */
function createShipStorage() {
  return register(createWorld(), Ship);
}

type ShipStorage = ReturnType<typeof createShipStorage>;

const noop = () => {};

/** A spawn count that fills a storage past its initial capacity of 8. */
const GROWTH_BATCH = 20;

describe("per-component storage alias", () => {
  it.each([
    { kind: "a required component with fields", comp: Position, name: "ContractPosition" },
    { kind: "a required tag", comp: Marked, name: "ContractMarked" },
    { kind: "a non-identifier component name", comp: Pair, name: "Contract A,B" },
    { kind: "an optional component with fields", comp: Shield, name: "ContractShield" },
  ])("is the storage's SoA record for $kind", ({ comp, name }) => {
    const storage = createShipStorage();

    const record = storage.columns.get(comp);

    assert(record != null);
    expect(Reflect.get(storage, name)).toBe(record);
  });

  it("gives a required tag a record with no fields", () => {
    const storage = createShipStorage();

    const record = storage.columns.get(Marked);

    expect(record).toStrictEqual({});
  });

  it("gives an optional tag neither a record nor an alias", () => {
    const storage = createShipStorage();

    const record = storage.columns.get(Stunned);

    expect(record).toBeUndefined();
    expect(Object.hasOwn(storage, "ContractStunned")).toBe(false);
  });
});

describe("SoA record across growth", () => {
  /** A Cargo-only storage holding one entity at initial capacity, with its record and pre-growth fields. */
  function arrangePopulatedCargoStorage() {
    const storage = register(createWorld(), archetype([Cargo]));
    const owner = { label: "crate" };
    spawn(storage, { ContractCargo: { weight: 7, owner } });
    const record = storage.columns.get(Cargo);
    assert(record != null);
    const weightBefore = record["weight"];
    const ownerBefore = record["owner"];

    return { storage, record, weightBefore, ownerBefore, owner };
  }

  it("keeps the alias and the columns entry pointing at the same record object", () => {
    const { storage, record } = arrangePopulatedCargoStorage();

    spawnMany(storage, GROWTH_BATCH);

    expect(Reflect.get(storage, "ContractCargo")).toBe(record);
    expect(storage.columns.get(Cargo)).toBe(record);
  });

  it("replaces typed-array fields with new arrays holding the pre-growth values", () => {
    const { storage, record, weightBefore } = arrangePopulatedCargoStorage();

    spawnMany(storage, GROWTH_BATCH);
    const weightAfter = record["weight"];

    assert(weightAfter instanceof Float64Array);
    assert(weightBefore instanceof Float64Array);
    expect(weightAfter).not.toBe(weightBefore);
    expect(weightAfter.length).toBeGreaterThan(weightBefore.length);
    expect(weightAfter.subarray(0, weightBefore.length)).toStrictEqual(weightBefore);
  });

  it("keeps plain-array fields as the same array objects", () => {
    const { storage, record, ownerBefore, owner } = arrangePopulatedCargoStorage();

    spawnMany(storage, GROWTH_BATCH);
    const ownerAfter = record["owner"];

    expect(ownerAfter).toBe(ownerBefore);
    expect(ownerAfter?.[0]).toBe(owner);
  });
});

describe("matcher identity", () => {
  /** The mask triple selecting rows that carry the optional Stunned tag. */
  function stunnedMasks(storage: ShipStorage) {
    const bit = storage.optionalBitLookup.get(Stunned);
    assert(bit != null);
    return { allMask: bit, anyMask: 0, noneMask: 0 };
  }

  it("returns the same matcher object for equal masks on one storage", () => {
    const storage = createShipStorage();
    const { allMask, anyMask, noneMask } = stunnedMasks(storage);
    const first = matcherFor(storage, allMask, anyMask, noneMask);

    const second = matcherFor(storage, allMask, anyMask, noneMask);

    expect(second).toBe(first);
  });

  it("replaces the matched array on the same matcher object when the storage grows", () => {
    const storage = createShipStorage();
    const { allMask, anyMask, noneMask } = stunnedMasks(storage);
    const matcher = matcherFor(storage, allMask, anyMask, noneMask);
    const matchedBefore = matcher.matched;

    spawnMany(storage, GROWTH_BATCH);

    expect(matcherFor(storage, allMask, anyMask, noneMask)).toBe(matcher);
    expect(matcher.matched).not.toBe(matchedBefore);
    expect(matcher.matched.length).toBe(storage.entities.length);
  });

  it.each([
    {
      op: "spawn",
      run: (storage: ShipStorage) => {
        spawn(storage);
      },
    },
    {
      op: "despawn",
      run: (storage: ShipStorage) => {
        despawn(storage, spawn(storage));
      },
    },
    {
      op: "growth",
      run: (storage: ShipStorage) => {
        spawnMany(storage, GROWTH_BATCH);
      },
    },
    {
      op: "repeated filtered each",
      run: (storage: ShipStorage) => {
        each(storage, { all: [Stunned] }, noop);
        each(storage, { none: [OnFire] }, noop);
        each(storage, { any: [Stunned, OnFire] }, noop);
      },
    },
  ])("keeps every registered matcher across $op", ({ run }) => {
    const storage = createShipStorage();
    spawn(storage);
    each(storage, { all: [Stunned] }, noop);
    each(storage, { none: [OnFire] }, noop);
    const [stunned, notOnFire] = storage.matchers;
    assert(stunned != null && notOnFire != null);

    run(storage);

    expect(storage.matchers).toContain(stunned);
    expect(storage.matchers).toContain(notOnFire);
  });
});

describe("filter resolution", () => {
  it("returns the same matcher for two distinct filter objects with equal contents", () => {
    const storage = createShipStorage();
    const first = resolveFilter(storage, { all: [Stunned], none: [OnFire] });

    const second = resolveFilter(storage, { all: [Stunned], none: [OnFire] });

    assert(first !== false);
    expect(first).not.toBe(TRIVIAL_MATCHER);
    expect(second).toBe(first);
  });

  /** The matcher selecting rows that carry Stunned and lack OnFire on `storage`. */
  function stunnedNotOnFire(storage: ShipStorage): Matcher {
    const stunned = storage.optionalBitLookup.get(Stunned);
    const onFire = storage.optionalBitLookup.get(OnFire);
    assert(stunned != null && onFire != null);
    return matcherFor(storage, stunned, 0, onFire);
  }

  const filterKinds = [
    {
      kind: "an optional-tag filter",
      makeFilter: () => ({ all: [Stunned], none: [OnFire] }),
      expected: (storage: ShipStorage): Matcher | false => stunnedNotOnFire(storage),
    },
    {
      kind: "a required-only filter",
      makeFilter: () => ({ all: [Position] }),
      expected: (): Matcher | false => TRIVIAL_MATCHER,
    },
    {
      kind: "a filter naming an absent component",
      makeFilter: () => ({ all: [Absent] }),
      expected: (): Matcher | false => false,
    },
  ];
  const storageStates = [
    { state: "fresh", grow: 0 },
    { state: "grown", grow: GROWTH_BATCH },
  ];

  it.each(
    filterKinds.flatMap((filterKind) =>
      storageStates.map((storageState) => ({
        kind: filterKind.kind,
        makeFilter: filterKind.makeFilter,
        expected: filterKind.expected,
        state: storageState.state,
        grow: storageState.grow,
      })),
    ),
  )("resolves $kind on a $state storage", ({ makeFilter, expected, grow }) => {
    const storage = createShipStorage();
    spawnMany(storage, grow);

    const result = resolveFilter(storage, makeFilter());

    expect(result).toBe(expected(storage));
  });
});
