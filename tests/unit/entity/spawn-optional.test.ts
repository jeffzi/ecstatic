import { assert, describe, expect, it } from "vitest";

import type { ComponentDescriptor } from "../../../src/component.js";
import {
  archetype,
  components,
  despawn,
  despawnMany,
  relation,
  spawn,
  spawnMany,
} from "../../../src/index.js";
import { getRelationMeta } from "../../../src/relation.js";
import { createWorld, register } from "../../../src/world.js";
import { rowOf } from "../fixtures.js";

const { SpawnOptPosition: Position } = components({
  SpawnOptPosition: { x: 0, y: 0 },
});
const { SpawnOptShield: Shield } = components({
  SpawnOptShield: { hp: 50, defense: 10 },
});
const { SpawnOptStunned: Stunned } = components({ SpawnOptStunned: {} });
const { SpawnOptOnFire: OnFire } = components({ SpawnOptOnFire: {} });

function createStorage<const O extends readonly ComponentDescriptor[]>(optionals: O) {
  const world = createWorld();
  return register(world, archetype([Position], optionals));
}

describe("spawn with optionals", () => {
  it("sets mask to 0 on spawn", () => {
    const storage = createStorage([Stunned]);

    const id = spawn(storage);

    expect(storage.mask[rowOf(storage, id)]).toBe(0);
  });

  it("pre-populates optional SoA with defaults on fresh spawn", () => {
    const storage = createStorage([Shield]);

    const id = spawn(storage);
    const row = rowOf(storage, id);

    const soa = storage.columns.get(Shield);

    assert(soa != null);
    expect(soa["hp"]?.[row]).toBe(50);
    expect(soa["defense"]?.[row]).toBe(10);
  });

  it("enables an optional data component with defaults on override true", () => {
    const storage = createStorage([Shield]);

    const id = spawn(storage, { SpawnOptShield: true });
    const row = rowOf(storage, id);

    const bit = storage.archetype.optionalBits.get("SpawnOptShield");

    assert(bit != null);
    expect(storage.mask[row]).toBe(bit);
    const soa = storage.columns.get(Shield);
    assert(soa != null);
    expect(soa["hp"]?.[row]).toBe(50);
    expect(soa["defense"]?.[row]).toBe(10);
  });

  it("enables an optional data component and patches listed fields on record override", () => {
    const storage = createStorage([Shield]);

    const id = spawn(storage, { SpawnOptShield: { hp: 200 } });
    const row = rowOf(storage, id);

    const bit = storage.archetype.optionalBits.get("SpawnOptShield");

    assert(bit != null);
    expect(storage.mask[row]).toBe(bit);
    const soa = storage.columns.get(Shield);
    assert(soa != null);
    expect(soa["hp"]?.[row]).toBe(200);
    expect(soa["defense"]?.[row]).toBe(10);
  });

  it("enables an optional tag on override true", () => {
    const storage = createStorage([Stunned]);

    const id = spawn(storage, { SpawnOptStunned: true });
    const row = rowOf(storage, id);

    expect(storage.mask[row]).toBe(storage.archetype.optionalBits.get("SpawnOptStunned"));
  });

  it("leaves optionals disabled on override false or omission", () => {
    const storage = createStorage([Stunned, OnFire]);

    const id = spawn(storage, { SpawnOptStunned: false });

    expect(storage.mask[rowOf(storage, id)]).toBe(0);
  });

  it("reflects exactly the enabled set for mixed overrides", () => {
    const storage = createStorage([Shield, Stunned]);

    const id = spawn(storage, {
      SpawnOptPosition: { x: 5, y: 0 },
      SpawnOptShield: true,
      SpawnOptStunned: true,
    });
    const row = rowOf(storage, id);

    const positionSoa = storage.columns.get(Position);

    assert(positionSoa != null);
    expect(positionSoa["x"]?.[row]).toBe(5);
    expect(positionSoa["y"]?.[row]).toBe(0);
    const shieldBit = storage.archetype.optionalBits.get("SpawnOptShield");
    assert(shieldBit != null);
    const stunnedBit = storage.archetype.optionalBits.get("SpawnOptStunned");
    assert(stunnedBit != null);
    expect(storage.mask[row]).toBe(shieldBit | stunnedBit);
  });

  it("applies the optional override grammar to every entity in spawnMany", () => {
    const storage = createStorage([Shield, Stunned]);

    const ids = spawnMany(storage, 3, { SpawnOptShield: { hp: 75 }, SpawnOptStunned: false });

    const shieldBit = storage.archetype.optionalBits.get("SpawnOptShield");

    assert(shieldBit != null);
    const soa = storage.columns.get(Shield);
    assert(soa != null);
    for (const id of ids) {
      const row = rowOf(storage, id);
      expect(storage.mask[row]).toBe(shieldBit);
      expect(soa["hp"]?.[row]).toBe(75);
      expect(soa["defense"]?.[row]).toBe(10);
    }
  });
});

describe("spawn pre-population on recycled slots", () => {
  it("re-populates optional defaults on a recycled slot", () => {
    const storage = createStorage([Shield]);

    const idA = spawn(storage, { SpawnOptShield: { hp: 99, defense: 7 } });
    despawn(storage, idA);

    const idB = spawn(storage);
    const row = rowOf(storage, idB);

    const soa = storage.columns.get(Shield);

    assert(soa != null);
    expect(soa["hp"]?.[row]).toBe(50);
    expect(soa["defense"]?.[row]).toBe(10);
  });

  it("re-populates optional defaults on recycled slots through the spawnMany batch path", () => {
    const storage = createStorage([Shield]);

    spawnMany(storage, 3, { SpawnOptShield: { hp: 99, defense: 7 } });
    despawnMany(storage);

    const ids = spawnMany(storage, 3);

    const soa = storage.columns.get(Shield);

    assert(soa != null);
    for (const id of ids) {
      const row = rowOf(storage, id);
      expect(soa["hp"]?.[row]).toBe(50);
      expect(soa["defense"]?.[row]).toBe(10);
    }
  });

  it("re-populates a disabled optional's defaults even when the spawn enables another optional", () => {
    const storage = createStorage([Shield, Stunned]);

    const idA = spawn(storage, { SpawnOptShield: { hp: 99, defense: 7 } });
    despawn(storage, idA);

    const idB = spawn(storage, { SpawnOptStunned: true });
    const row = rowOf(storage, idB);

    const soa = storage.columns.get(Shield);

    assert(soa != null);
    expect(soa["hp"]?.[row]).toBe(50);
    expect(soa["defense"]?.[row]).toBe(10);
  });
});

describe("hasOptionalData flag", () => {
  it("is true when any optional carries data fields", () => {
    const storage = createStorage([Shield]);

    expect(storage.hasOptionalData).toBe(true);
  });

  it("is false for tag-only optionals", () => {
    const storage = createStorage([Stunned, OnFire]);

    expect(storage.hasOptionalData).toBe(false);
  });

  it("is true when a pure-link optional relation joins tag-only optionals", () => {
    const Owner = relation("SpawnOptRelation_Owner");
    const world = createWorld();
    const storage = register(world, archetype([Position], [Stunned, Owner]));

    // Sentinel target-column init runs through the optional-defaults path.
    expect(storage.hasOptionalData).toBe(true);
  });
});

describe("spawn mixing optional relations with plain optionals", () => {
  it("enables the plain optional and leaves the omitted relation unlinked", () => {
    const Follows = relation("SpawnOptRelation_Follows");
    const world = createWorld();
    const storage = register(world, archetype([Position], [Shield, Follows]));

    const id = spawn(storage, { SpawnOptShield: { hp: 7 } });

    const row = rowOf(storage, id);
    expect(storage.mask[row]).toBe(storage.optionalBitLookup.get(Shield));
    const followsMeta = getRelationMeta(Follows);
    assert(followsMeta != null);
    expect(storage.columns.get(followsMeta)?.["target"]?.[row]).toBe(0);
  });
});
