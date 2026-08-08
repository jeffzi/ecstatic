import { describe, expect, it } from "vitest";

import {
  alive,
  archetype,
  components,
  createWorld,
  despawn,
  disableMany,
  each,
  enable,
  enableMany,
  has,
  ref,
  register,
  spawn,
  spawnMany,
} from "../src/index.js";
import { rowOf } from "./fixtures.js";

const { ManyPosition: Position } = components({ ManyPosition: { x: 0, y: 0 } });
const { ManyShield: Shield } = components({ ManyShield: { hp: 50, defense: 10 } });
const { ManyStunned: Stunned } = components({ ManyStunned: {} });
const { ManyOnFire: OnFire } = components({ ManyOnFire: {} });

function createStorage() {
  const world = createWorld();
  const storage = register(world, archetype([Position], [Shield, Stunned, OnFire]));
  return { world, storage };
}

describe("enableMany with ids", () => {
  it("enables optional tag on listed entities, leaves unlisted unchanged", () => {
    const { storage } = createStorage();
    const idA = spawn(storage);
    const idB = spawn(storage);
    const idC = spawn(storage);

    enableMany(storage, [idA, idB], { ManyStunned: true });

    expect(has(storage, idA, Stunned)).toBe(true);
    expect(has(storage, idB, Stunned)).toBe(true);
    expect(has(storage, idC, Stunned)).toBe(false);
  });

  it("enables multiple components in one call", () => {
    const { storage } = createStorage();
    const id = spawn(storage);

    enableMany(storage, [id], { ManyStunned: true, ManyShield: { hp: 75 } });

    expect(has(storage, id, [Stunned, Shield])).toBe(true);
    expect(storage.columns.get(Shield)!.hp![rowOf(storage, id)]).toBe(75);
  });

  it("filters false entries at resolve time", () => {
    const { storage } = createStorage();
    const id = spawn(storage);

    enableMany(storage, [id], { ManyStunned: true, ManyOnFire: false });

    expect(has(storage, id, Stunned)).toBe(true);
    expect(has(storage, id, OnFire)).toBe(false);
  });

  it("treats an all-false record as a no-op", () => {
    const { storage } = createStorage();
    const id = spawn(storage);

    enableMany(storage, [id], { ManyStunned: false, ManyOnFire: false });

    expect(storage.mask[rowOf(storage, id)]).toBe(0);
  });

  it("resumes initialized entities and initializes fresh ones per-entity", () => {
    const { storage } = createStorage();
    const idA = spawn(storage);
    const idB = spawn(storage);

    enable(storage, idA, Shield, { hp: 75 });
    disableMany(storage, [idA], [Shield]);

    enableMany(storage, [idA, idB], { ManyShield: true });

    const soa = storage.columns.get(Shield)!;
    expect(soa.hp![rowOf(storage, idA)]).toBe(75);
    expect(soa.defense![rowOf(storage, idA)]).toBe(10);
    expect(soa.hp![rowOf(storage, idB)]).toBe(50);
    expect(soa.defense![rowOf(storage, idB)]).toBe(10);
  });

  it("is idempotent — calling twice succeeds, entity remains alive", () => {
    const { storage } = createStorage();
    const id = spawn(storage);

    enableMany(storage, [id], { ManyStunned: true });
    enableMany(storage, [id], { ManyStunned: true });

    expect(has(storage, id, Stunned)).toBe(true);
    expect(alive(storage, id)).toBe(true);
  });

  it("stores object override by reference (shared object)", () => {
    const { ManyAura: Aura } = components({
      ManyAura: { effect: ref<{ charges: number }>() },
    });
    const world = createWorld();
    const storage = register(world, archetype([Position], [Aura]));
    const idA = spawn(storage);
    const idB = spawn(storage);
    const obj = { charges: 1 };

    enableMany(storage, [idA, idB], { ManyAura: { effect: obj } });

    const soa = storage.columns.get(Aura)!;
    expect(soa.effect![rowOf(storage, idA)]).toBe(obj);
    expect(soa.effect![rowOf(storage, idB)]).toBe(obj);
  });

  it("errors on a stale entity ID with zero rows changed", () => {
    const { storage } = createStorage();
    const idA = spawn(storage);
    const idB = spawn(storage);
    despawn(storage, idB);

    expect(() => {
      enableMany(storage, [idA, idB], { ManyStunned: true });
    }).toThrow("stale entity ID");
    expect(has(storage, idA, Stunned)).toBe(false);
  });

  it("errors on an unknown component name with zero rows changed", () => {
    const { storage } = createStorage();
    const id = spawn(storage);

    expect(() => {
      // @ts-expect-error Nope is not on this archetype — runtime validates too
      enableMany(storage, [id], { ManyStunned: true, Nope: true });
    }).toThrow("unknown component name: Nope");
    expect(storage.mask[rowOf(storage, id)]).toBe(0);
  });

  it("errors on a non-optional component in overrides with zero rows changed", () => {
    const { storage } = createStorage();
    const id = spawn(storage);

    expect(() => {
      // @ts-expect-error Position is required, not optional — runtime validates too
      enableMany(storage, [id], { ManyStunned: true, ManyPosition: true });
    }).toThrow("component ManyPosition is not optional on this archetype");
    expect(storage.mask[rowOf(storage, id)]).toBe(0);
  });
});

describe("enableMany without ids", () => {
  it("enables component on ALL entities in archetype", () => {
    const { storage } = createStorage();
    const ids = spawnMany(storage, 3);

    enableMany(storage, { ManyStunned: true, ManyOnFire: false });

    for (const id of ids) {
      expect(has(storage, id, Stunned)).toBe(true);
      expect(has(storage, id, OnFire)).toBe(false);
    }
  });

  it("handles empty archetype gracefully (n=0)", () => {
    const { storage } = createStorage();

    expect(() => {
      enableMany(storage, { ManyStunned: true });
    }).not.toThrow();
    expect(storage.n).toBe(0);
  });
});

describe("disableMany with ids", () => {
  it("disables optional tag on listed entities, leaves unlisted unchanged", () => {
    const { storage } = createStorage();
    const idA = spawn(storage);
    const idB = spawn(storage);
    const idC = spawn(storage);
    enableMany(storage, { ManyStunned: true });

    disableMany(storage, [idA, idB], [Stunned]);

    expect(has(storage, idA, Stunned)).toBe(false);
    expect(has(storage, idB, Stunned)).toBe(false);
    expect(has(storage, idC, Stunned)).toBe(true);
  });

  it("disables multiple components in one call", () => {
    const { storage } = createStorage();
    const id = spawn(storage);
    enableMany(storage, [id], { ManyStunned: true, ManyOnFire: true });

    disableMany(storage, [id], [Stunned, OnFire]);

    expect(has(storage, id, Stunned)).toBe(false);
    expect(has(storage, id, OnFire)).toBe(false);
  });

  it("is idempotent — calling twice on already-disabled entity succeeds", () => {
    const { storage } = createStorage();
    const id = spawn(storage);

    disableMany(storage, [id], [Stunned]);
    disableMany(storage, [id], [Stunned]);

    expect(has(storage, id, Stunned)).toBe(false);
    expect(alive(storage, id)).toBe(true);
  });

  it("errors on a stale entity ID with zero rows changed", () => {
    const { storage } = createStorage();
    const idA = spawn(storage);
    const idB = spawn(storage);
    enableMany(storage, { ManyStunned: true });
    despawn(storage, idB);

    expect(() => {
      disableMany(storage, [idA, idB], [Stunned]);
    }).toThrow("stale entity ID");
    expect(has(storage, idA, Stunned)).toBe(true);
  });

  it("errors on a non-optional component in the comps array with zero rows changed", () => {
    const { storage } = createStorage();
    const id = spawn(storage);
    enableMany(storage, [id], { ManyStunned: true });

    expect(() => {
      // @ts-expect-error Position is required, not optional — runtime validates too
      disableMany(storage, [id], [Stunned, Position]);
    }).toThrow("component ManyPosition is not optional on this archetype");
    expect(has(storage, id, Stunned)).toBe(true);
  });

  it("errors on an empty comps array", () => {
    const { storage } = createStorage();
    const id = spawn(storage);

    expect(() => {
      // @ts-expect-error the empty tuple is rejected at the type level too
      disableMany(storage, [id], []);
    }).toThrow("disableMany requires at least one component");
  });
});

describe("disableMany without ids", () => {
  it("disables component on ALL entities in archetype", () => {
    const { storage } = createStorage();
    const ids = spawnMany(storage, 3);
    enableMany(storage, { ManyStunned: true });

    disableMany(storage, [Stunned]);

    for (const id of ids) {
      expect(has(storage, id, Stunned)).toBe(false);
    }
  });

  it("handles empty archetype gracefully (n=0)", () => {
    const { storage } = createStorage();

    expect(() => {
      disableMany(storage, [Stunned]);
    }).not.toThrow();
    expect(storage.n).toBe(0);
  });

  it("errors on an empty comps array", () => {
    const { storage } = createStorage();

    expect(() => {
      // @ts-expect-error the empty tuple is rejected at the type level too
      disableMany(storage, []);
    }).toThrow("disableMany requires at least one component");
  });
});

describe("batch matched sync (apply-mask-many parity)", () => {
  // Alpha ∧ (Beta ∨ Gamma) ∧ ¬Delta driven through the batch enable/disable ops.
  const { BatchAlpha: Alpha } = components({ BatchAlpha: {} });
  const { BatchBeta: Beta } = components({ BatchBeta: {} });
  const { BatchGamma: Gamma } = components({ BatchGamma: {} });
  const { BatchDelta: Delta } = components({ BatchDelta: {} });
  const { BatchExtra: Extra } = components({ BatchExtra: {} });

  function createBatchStorage() {
    const world = createWorld();
    const storage = register(world, archetype([Position], [Alpha, Beta, Gamma, Delta, Extra]));
    return { world, storage };
  }

  type BatchStorage = ReturnType<typeof createBatchStorage>["storage"];

  function registerMatcher(storage: BatchStorage): void {
    each(storage, { all: [Alpha], any: [Beta, Gamma], none: [Delta] }, () => {});
  }

  function matchedIds(storage: BatchStorage): number[] {
    const visited: number[] = [];
    each(storage, { all: [Alpha], any: [Beta, Gamma], none: [Delta] }, (e) => {
      visited.push(e.id);
    });
    return visited;
  }

  it("enableMany to a satisfying state matches every entity", () => {
    const { storage } = createBatchStorage();
    const id1 = spawn(storage);
    const id2 = spawn(storage);

    registerMatcher(storage);
    enableMany(storage, { BatchAlpha: true, BatchBeta: true });

    expect(new Set(matchedIds(storage))).toStrictEqual(new Set([id1, id2]));
  });

  it("enableMany with only the all-clause matches none (any-clause guard)", () => {
    const { storage } = createBatchStorage();
    spawn(storage);
    spawn(storage);

    registerMatcher(storage);
    enableMany(storage, { BatchAlpha: true });

    expect(matchedIds(storage)).toStrictEqual([]);
  });

  it("enableMany setting a none-clause tag excludes entities", () => {
    const { storage } = createBatchStorage();
    spawn(storage);

    registerMatcher(storage);
    enableMany(storage, { BatchAlpha: true, BatchBeta: true, BatchDelta: true });

    expect(matchedIds(storage)).toStrictEqual([]);
  });

  it("disableMany clearing the any-clause drops entities from the set", () => {
    const { storage } = createBatchStorage();
    const id1 = spawn(storage);
    const id2 = spawn(storage);

    registerMatcher(storage);
    enableMany(storage, { BatchAlpha: true, BatchBeta: true });
    expect(new Set(matchedIds(storage))).toStrictEqual(new Set([id1, id2]));

    disableMany(storage, [Beta]);
    expect(matchedIds(storage)).toStrictEqual([]);
  });

  it("ids-form enableMany adds exactly the listed rows to the visit set", () => {
    const { storage } = createBatchStorage();
    const idA = spawn(storage);
    const idB = spawn(storage);
    const idC = spawn(storage);

    registerMatcher(storage);
    enableMany(storage, [idA, idB], { BatchAlpha: true, BatchGamma: true });

    expect(new Set(matchedIds(storage))).toStrictEqual(new Set([idA, idB]));
    expect(matchedIds(storage)).not.toContain(idC);
  });

  it("ids-form disableMany removes exactly the listed rows from the visit set", () => {
    const { storage } = createBatchStorage();
    const idA = spawn(storage);
    const idB = spawn(storage);

    registerMatcher(storage);
    enableMany(storage, { BatchAlpha: true, BatchBeta: true });

    disableMany(storage, [idA], [Alpha]);

    expect(matchedIds(storage)).toStrictEqual([idB]);
  });

  it("batch refresh skips matchers whose filter mask doesn't overlap the changed bits", () => {
    const { storage } = createBatchStorage();
    const idMatch = spawn(storage, { BatchAlpha: true, BatchBeta: true });
    spawn(storage, { BatchAlpha: true });

    registerMatcher(storage);

    // Extra is outside the parity filter's mask: batch-enabling it must not
    // recompute (or disturb) the parity matcher's visit set.
    enableMany(storage, { BatchExtra: true });

    expect(matchedIds(storage)).toStrictEqual([idMatch]);
  });
});
