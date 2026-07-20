import { describe, expect, it } from "vitest";

import { entityIndex, initialEntityId, MAX_GEN, MAX_INDEX } from "../src/entity-id.js";
import { alive, archetype, components, despawn, ref, spawn } from "../src/index.js";
import { createWorld, register } from "../src/world.js";

const { DespawnTestPosition: Position } = components({
  DespawnTestPosition: { x: 0, y: 0 },
});
const { DespawnTestVelocity: Velocity } = components({
  DespawnTestVelocity: { vx: 0, vy: 0 },
});

describe("despawn", () => {
  it("removes entity from archetype", () => {
    const world = createWorld();
    const Arch = archetype([Position]);
    const storage = register(world, Arch);

    const id = spawn(storage);
    despawn(storage, id);

    expect(storage.n).toBe(0);
  });

  it("swaps SOA data with last entity", () => {
    const world = createWorld();
    const Arch = archetype([Position]);
    const storage = register(world, Arch);

    spawn(storage, {
      DespawnTestPosition: { x: 10, y: 20 },
    });
    const id2 = spawn(storage, {
      DespawnTestPosition: { x: 30, y: 40 },
    });
    spawn(storage, {
      DespawnTestPosition: { x: 50, y: 60 },
    });

    // Remove middle entity — last entity (50,60) should swap into its index
    despawn(storage, id2);

    const pos = storage.columns.get(Position)!;
    // Dense row 0: original entity (10,20)
    expect(pos.x![0]).toBe(10);
    expect(pos.y![0]).toBe(20);
    // Dense row 1: swapped-in entity (50,60)
    expect(pos.x![1]).toBe(50);
    expect(pos.y![1]).toBe(60);
    expect(storage.n).toBe(2);
  });

  it("swaps ids array entry on despawn", () => {
    const world = createWorld();
    const Arch = archetype([Position]);
    const storage = register(world, Arch);

    const id1 = spawn(storage);
    const id2 = spawn(storage);
    const id3 = spawn(storage);

    // Remove middle entity — last entity's id should swap into its index
    despawn(storage, id2);

    expect(storage.entities[0]).toBe(id1);
    expect(storage.entities[1]).toBe(id3);
    expect(storage.n).toBe(2);
  });

  it("is a no-op on stale entity ID", () => {
    const world = createWorld();
    const Arch = archetype([Position]);
    const storage = register(world, Arch);
    const id = spawn(storage);
    despawn(storage, id);

    // Spawn reuses the index with a new generation
    const newId = spawn(storage);

    // Old ID has stale generation — must be a no-op, not an error
    expect(() => {
      despawn(storage, id);
    }).not.toThrow();
    expect(alive(storage, newId)).toBe(true);
    expect(storage.n).toBe(1);
  });
});

describe("alive", () => {
  describe("storage overload", () => {
    it("returns true for live entities", () => {
      const world = createWorld();
      const Arch = archetype([Position]);
      const storage = register(world, Arch);
      const id = spawn(storage);

      expect(alive(storage, id)).toBe(true);
    });

    it("returns false after despawn", () => {
      const world = createWorld();
      const Arch = archetype([Position]);
      const storage = register(world, Arch);
      const id = spawn(storage);
      despawn(storage, id);

      expect(alive(storage, id)).toBe(false);
    });

    it("returns false for stale IDs after index reuse", () => {
      const world = createWorld();
      const Arch = archetype([Position]);
      const storage = register(world, Arch);
      const oldId = spawn(storage);
      despawn(storage, oldId);
      const newId = spawn(storage);

      expect(alive(storage, oldId)).toBe(false);
      expect(alive(storage, newId)).toBe(true);
      // LIFO freelist: the freed index is reused with a bumped generation
      expect(entityIndex(newId)).toBe(entityIndex(oldId));
      expect(newId).not.toBe(oldId);
    });
  });

  describe("world overload", () => {
    it("returns true for a living entity spawned in any archetype of that world", () => {
      const world = createWorld();
      const Arch = archetype([Position]);
      const storage = register(world, Arch);
      const id = spawn(storage);

      expect(alive(world, id)).toBe(true);
    });

    it("returns false after the entity is despawned", () => {
      const world = createWorld();
      const Arch = archetype([Position]);
      const storage = register(world, Arch);
      const id = spawn(storage);
      despawn(storage, id);

      expect(alive(world, id)).toBe(false);
    });

    it("returns false for a stale ID after index reuse", () => {
      const world = createWorld();
      const Arch = archetype([Position]);
      const storage = register(world, Arch);
      const oldId = spawn(storage);
      despawn(storage, oldId);
      spawn(storage);

      expect(alive(world, oldId)).toBe(false);
    });
  });
});

describe("despawn world overload", () => {
  it("removes entity regardless of which archetype it belongs to", () => {
    const world = createWorld();
    const Arch1 = archetype([Position]);
    const Arch2 = archetype([Velocity]);
    const storage1 = register(world, Arch1);
    const storage2 = register(world, Arch2);
    const id1 = spawn(storage1);
    const id2 = spawn(storage2);

    despawn(world, id1);
    despawn(world, id2);

    expect(storage1.n).toBe(0);
    expect(storage2.n).toBe(0);
  });

  it("is a no-op on stale entity ID after index reuse", () => {
    const world = createWorld();
    const Arch = archetype([Position]);
    const storage = register(world, Arch);
    const oldId = spawn(storage);
    spawn(storage); // second entity — stays alive
    despawn(storage, oldId);
    const newId = spawn(storage); // reuses oldId's index with new generation

    // oldId is stale: world form must be a no-op, leaving both survivors intact
    expect(() => {
      despawn(world, oldId);
    }).not.toThrow();
    expect(alive(storage, newId)).toBe(true);
    expect(storage.n).toBe(2);
  });

  it("is a no-op when entity already despawned", () => {
    const world = createWorld();
    const Arch = archetype([Position]);
    const storage = register(world, Arch);
    const id = spawn(storage);

    despawn(world, id);

    expect(() => {
      despawn(world, id);
    }).not.toThrow();
    expect(alive(storage, id)).toBe(false);
    expect(storage.n).toBe(0);
  });

  it("does not affect despawn(storage, id) behavior", () => {
    const world = createWorld();
    const Arch = archetype([Position]);
    const storage = register(world, Arch);
    const id = spawn(storage);

    despawn(storage, id);

    expect(storage.n).toBe(0);
  });

  it("alive(world, id) returns false after despawn(world, id)", () => {
    const world = createWorld();
    const Arch = archetype([Position]);
    const storage = register(world, Arch);
    const id = spawn(storage);

    despawn(world, id);

    expect(alive(world, id)).toBe(false);
  });
});

describe("despawn safety checks", () => {
  it("errors under DEBUG when a live ID is despawned through the wrong storage", () => {
    const world = createWorld();
    const storage1 = register(world, archetype([Position]));
    const storage2 = register(world, archetype([Velocity]));
    const id = spawn(storage1);

    expect(() => {
      despawn(storage2, id);
    }).toThrow("entity ID does not belong to this storage");
  });

  it("wraps the generation to 1 when the advance would reach MAX_GEN", () => {
    const world = createWorld();
    const Arch = archetype([Position]);
    const storage = register(world, Arch);
    const id = spawn(storage);
    const index = entityIndex(id);

    // Force the slot to the last representable generation, then despawn it.
    const ceilingId = ((MAX_GEN - 1) * MAX_INDEX + index) as typeof id;
    world.generation[index] = ceilingId;
    storage.entities[0] = ceilingId;
    despawn(storage, ceilingId);

    // The recycled slot restarts at generation 1 instead of overflowing.
    expect(spawn(storage)).toBe(initialEntityId(index));
  });

  it("clears ref-column tail slot on despawn (GC safety)", () => {
    const { DespawnRefComp: RefComp } = components({
      DespawnRefComp: { handle: ref() },
    });

    const world = createWorld();
    const Arch = archetype([RefComp]);
    const storage = register(world, Arch);

    const obj = { data: "held" };
    const id1 = spawn(storage, { DespawnRefComp: { handle: obj } });
    spawn(storage, { DespawnRefComp: { handle: { data: "other" } } });

    despawn(storage, id1);

    const col = storage.columns.get(RefComp)!;
    // After swap-pop, tail slot (index 1) must be cleared to release the ref
    expect(col.handle![1]).toBeUndefined();
  });

  it("world-form despawn is a no-op when entityArch[index] is unset", () => {
    const world = createWorld();
    const Arch = archetype([Position]);
    const storage = register(world, Arch);
    const id = spawn(storage);

    // Manually clear entityArch to simulate the branch
    const index = entityIndex(id);
    (world as unknown as { entityArch: unknown[] }).entityArch[index] = undefined;

    expect(() => {
      despawn(world, id);
    }).not.toThrow();
    // Storage should be untouched
    expect(storage.n).toBe(1);
  });
});
