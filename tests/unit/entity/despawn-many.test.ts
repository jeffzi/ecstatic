import { describe, expect, it } from "vitest";

import { alive, archetype, components, despawn, despawnMany, spawn } from "../../../src/index.js";
import { createWorld, register } from "../../../src/world.js";

const { DespawnManyTestPosition: Position } = components({
  DespawnManyTestPosition: { x: 0, y: 0 },
});

const { DespawnManyTestVelocity: Velocity } = components({
  DespawnManyTestVelocity: { vx: 0, vy: 0 },
});

describe("despawnMany storage form", () => {
  describe("without ids", () => {
    it("removes all entities and sets storage.n to 0", () => {
      const world = createWorld();
      const Arch = archetype([Position]);
      const storage = register(world, Arch);

      spawn(storage);
      spawn(storage);
      spawn(storage);

      despawnMany(storage);

      expect(storage.n).toBe(0);
    });

    it("invalidates entity IDs after clearing", () => {
      const world = createWorld();
      const Arch = archetype([Position]);
      const storage = register(world, Arch);

      const id1 = spawn(storage);
      const id2 = spawn(storage);

      despawnMany(storage);

      expect(alive(storage, id1)).toBe(false);
      expect(alive(storage, id2)).toBe(false);
    });

    it("allows freed indices to be reused by subsequent spawns with bumped generation", () => {
      const world = createWorld();
      const Arch = archetype([Position]);
      const storage = register(world, Arch);

      const id1 = spawn(storage);
      const id2 = spawn(storage);

      despawnMany(storage);
      expect(storage.n).toBe(0);

      const newId1 = spawn(storage);
      const newId2 = spawn(storage);

      expect(storage.n).toBe(2);
      expect(alive(storage, newId1)).toBe(true);
      expect(alive(storage, newId2)).toBe(true);
      expect(alive(storage, id1)).toBe(false);
      expect(alive(storage, id2)).toBe(false);
    });

    it("is a no-op on empty storage", () => {
      const world = createWorld();
      const Arch = archetype([Position]);
      const storage = register(world, Arch);

      expect(() => {
        despawnMany(storage);
      }).not.toThrow();

      expect(storage.n).toBe(0);
    });
  });

  describe("with ids", () => {
    it("despawns only the listed entities, leaves others alive", () => {
      const world = createWorld();
      const Arch = archetype([Position]);
      const storage = register(world, Arch);

      const id1 = spawn(storage);
      const id2 = spawn(storage);
      const id3 = spawn(storage);

      despawnMany(storage, [id1, id3]);

      expect(alive(storage, id1)).toBe(false);
      expect(alive(storage, id2)).toBe(true);
      expect(alive(storage, id3)).toBe(false);
    });

    it("maintains swap-pop correctness: surviving entities remain alive", () => {
      const world = createWorld();
      const Arch = archetype([Position]);
      const storage = register(world, Arch);

      const id1 = spawn(storage);
      const id2 = spawn(storage);
      const id3 = spawn(storage);
      const id4 = spawn(storage);
      const id5 = spawn(storage);

      despawnMany(storage, [id2, id4]);

      expect(alive(storage, id1)).toBe(true);
      expect(alive(storage, id2)).toBe(false);
      expect(alive(storage, id3)).toBe(true);
      expect(alive(storage, id4)).toBe(false);
      expect(alive(storage, id5)).toBe(true);
      expect(storage.n).toBe(3);
    });

    it("errors on duplicate id in the list, leaving world intact", () => {
      const world = createWorld();
      const Arch = archetype([Position]);
      const storage = register(world, Arch);

      const id1 = spawn(storage);
      const id2 = spawn(storage);
      const id3 = spawn(storage);

      expect(() => {
        despawnMany(storage, [id1, id2, id1]);
      }).toThrow("duplicate entity ID in despawnMany");

      expect(alive(storage, id1)).toBe(true);
      expect(alive(storage, id2)).toBe(true);
      expect(alive(storage, id3)).toBe(true);
      expect(storage.n).toBe(3);
    });

    it("restores back-pointers on duplicate-id error for retry with deduped list", () => {
      const world = createWorld();
      const Arch = archetype([Position]);
      const storage = register(world, Arch);

      const id1 = spawn(storage);
      const id2 = spawn(storage);
      const id3 = spawn(storage);

      expect(() => {
        despawnMany(storage, [id1, id2, id1]);
      }).toThrow("duplicate entity ID in despawnMany");

      expect(alive(storage, id1)).toBe(true);
      expect(alive(storage, id2)).toBe(true);
      expect(alive(storage, id3)).toBe(true);
      expect(storage.n).toBe(3);

      expect(() => {
        despawnMany(storage, [id1, id2]);
      }).not.toThrow();

      expect(alive(storage, id1)).toBe(false);
      expect(alive(storage, id2)).toBe(false);
      expect(alive(storage, id3)).toBe(true);
      expect(storage.n).toBe(1);
    });

    it("skips stale ids in the list without error", () => {
      const world = createWorld();
      const Arch = archetype([Position]);
      const storage = register(world, Arch);

      const id1 = spawn(storage);
      const id2 = spawn(storage);
      const id3 = spawn(storage);

      despawn(storage, id2);

      expect(() => {
        despawnMany(storage, [id1, id2, id3]);
      }).not.toThrow();

      expect(alive(storage, id1)).toBe(false);
      expect(alive(storage, id2)).toBe(false);
      expect(alive(storage, id3)).toBe(false);
      expect(storage.n).toBe(0);
    });
  });
});

describe("despawnMany world form", () => {
  describe("without ids", () => {
    it("removes all entities from all storages", () => {
      const world = createWorld();
      const Arch1 = archetype([Position]);
      const Arch2 = archetype([Velocity]);
      const storage1 = register(world, Arch1);
      const storage2 = register(world, Arch2);

      const p1 = spawn(storage1);
      const p2 = spawn(storage1);
      const e1 = spawn(storage2);

      despawnMany(world);

      expect(alive(world, p1)).toBe(false);
      expect(alive(world, p2)).toBe(false);
      expect(alive(world, e1)).toBe(false);
      expect(storage1.n).toBe(0);
      expect(storage2.n).toBe(0);
    });
  });

  describe("with ids", () => {
    it("despawns entities across multiple archetypes", () => {
      const world = createWorld();
      const Arch1 = archetype([Position]);
      const Arch2 = archetype([Velocity]);
      const storage1 = register(world, Arch1);
      const storage2 = register(world, Arch2);

      const p1 = spawn(storage1);
      const p2 = spawn(storage1);
      const e1 = spawn(storage2);
      const e2 = spawn(storage2);

      despawnMany(world, [p1, e1, p2, e2]);

      expect(alive(world, p1)).toBe(false);
      expect(alive(world, p2)).toBe(false);
      expect(alive(world, e1)).toBe(false);
      expect(alive(world, e2)).toBe(false);
    });

    it("silently skips duplicate ids in world form", () => {
      const world = createWorld();
      const Arch = archetype([Position]);
      const storage = register(world, Arch);

      const id1 = spawn(storage);
      const id2 = spawn(storage);
      const id3 = spawn(storage);

      // World form silently skips duplicates (different from storage form)
      expect(() => {
        despawnMany(world, [id1, id2, id1]);
      }).not.toThrow();

      expect(alive(world, id1)).toBe(false);
      expect(alive(world, id2)).toBe(false);
      expect(alive(world, id3)).toBe(true);
    });

    it("skips stale IDs without error", () => {
      const world = createWorld();
      const Arch = archetype([Position]);
      const storage = register(world, Arch);

      const id1 = spawn(storage);
      const id2 = spawn(storage);

      despawn(storage, id1);

      despawnMany(world, [id1, id2]);

      expect(alive(world, id1)).toBe(false);
      expect(alive(world, id2)).toBe(false);
    });
  });
});

describe("alive after despawnMany", () => {
  it("world form alive returns false after despawnMany", () => {
    const world = createWorld();
    const Arch = archetype([Position]);
    const storage = register(world, Arch);
    const id = spawn(storage);

    expect(alive(world, id)).toBe(true);

    despawnMany(world);

    expect(alive(world, id)).toBe(false);
  });
});

describe("despawnMany error recovery", () => {
  it("duplicate-id error does not break world-form despawn", () => {
    const world = createWorld();
    const Arch = archetype([Position]);
    const storage = register(world, Arch);
    const id1 = spawn(storage);
    const id2 = spawn(storage);

    expect(() => {
      despawnMany(storage, [id1, id1]);
    }).toThrow("duplicate entity ID in despawnMany");

    expect(() => {
      despawn(world, id1);
    }).not.toThrow();

    expect(alive(storage, id1)).toBe(false);
    expect(alive(storage, id2)).toBe(true);
  });
});
