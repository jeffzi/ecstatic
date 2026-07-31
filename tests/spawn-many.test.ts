import { describe, expect, it } from "vitest";

import { MAX_INDEX } from "../src/entity-id.js";
import { alive, archetype, components, despawn, type EntityId, spawnMany } from "../src/index.js";
import { createWorld, register } from "../src/world.js";

const { SpawnManyTestPosition: Position } = components({
  SpawnManyTestPosition: { x: 0, y: 0 },
});

const { SpawnManyTestShield: Shield } = components({
  SpawnManyTestShield: { hp: 50, defense: 10 },
});

describe("spawnMany", () => {
  it.each([{ count: 0 }, { count: 1 }, { count: 3 }])(
    "returns array of $count EntityId values with all alive",
    ({ count }) => {
      const world = createWorld();
      const Arch = archetype([Position]);
      const storage = register(world, Arch);

      const ids = spawnMany(storage, count);

      expect(ids).toHaveLength(count);
      for (const id of ids) {
        expect(alive(storage, id)).toBe(true);
      }
    },
  );

  it("initializes required component SOA fields with defaults for each spawned entity", () => {
    const world = createWorld();
    const Arch = archetype([Position, Shield]);
    const storage = register(world, Arch);

    spawnMany(storage, 2);

    // Position is required — defaults must be written at spawn time
    const posSoa = storage.columns.get(Position)!;
    for (let i = 0; i < 2; i++) {
      expect(posSoa.x![i]).toBe(0);
      expect(posSoa.y![i]).toBe(0);
    }
  });

  describe("with overrides", () => {
    it("writes full override values for required component fields", () => {
      const world = createWorld();
      const Arch = archetype([Position, Shield]);
      const storage = register(world, Arch);

      spawnMany(storage, 2, {
        [Position.__ecstatic_name]: { x: 10, y: 20 },
      });

      const posSoa = storage.columns.get(Position)!;
      for (let i = 0; i < 2; i++) {
        expect(posSoa.x![i]).toBe(10);
        expect(posSoa.y![i]).toBe(20);
      }
    });

    it("writes partial override while keeping defaults for unspecified fields", () => {
      const world = createWorld();
      const Arch = archetype([Position, Shield]);
      const storage = register(world, Arch);

      spawnMany(storage, 2, {
        [Position.__ecstatic_name]: { x: 10 },
      });

      const posSoa = storage.columns.get(Position)!;
      for (let i = 0; i < 2; i++) {
        expect(posSoa.x![i]).toBe(10);
        expect(posSoa.y![i]).toBe(0);
      }
    });
  });

  describe("freelist drain and generational ID correctness", () => {
    it("reuses despawned slots on spawnMany (freelist-first allocation)", () => {
      const world = createWorld();
      const Arch = archetype([Position]);
      const storage = register(world, Arch);

      // Spawn initial entities
      const id1 = spawnMany(storage, 1)[0]!;
      const id2 = spawnMany(storage, 1)[0]!;
      const id3 = spawnMany(storage, 1)[0]!;

      // Despawn id1 and id2, creating freelist entries
      despawn(storage, id1);
      despawn(storage, id2);

      // spawnMany should reuse those slots
      const newIds = spawnMany(storage, 2);

      // The new entities are alive
      expect(alive(storage, newIds[0]!)).toBe(true);
      expect(alive(storage, newIds[1]!)).toBe(true);

      // The old despawned IDs are stale (generation changed)
      expect(alive(storage, id1)).toBe(false);
      expect(alive(storage, id2)).toBe(false);

      // Original id3 is still alive
      expect(alive(storage, id3)).toBe(true);
    });

    it("detects stale IDs after freelist reuse", () => {
      const world = createWorld();
      const Arch = archetype([Position]);
      const storage = register(world, Arch);

      const id = spawnMany(storage, 1)[0]!;
      despawn(storage, id);

      // Spawn a new entity in the freed slot (new generation)
      const newId = spawnMany(storage, 1)[0]!;

      // Old ID is stale, new ID is alive
      expect(alive(storage, id)).toBe(false);
      expect(alive(storage, newId)).toBe(true);
    });

    it("mixes freelist reuse and fresh allocation when despawn_count < spawn_count", () => {
      const world = createWorld();
      const Arch = archetype([Position]);
      const storage = register(world, Arch);

      const id1 = spawnMany(storage, 1)[0]!;
      const id2 = spawnMany(storage, 1)[0]!;
      const id3 = spawnMany(storage, 1)[0]!;

      // Despawn only id1
      despawn(storage, id1);

      // spawnMany 2: first comes from freelist (id1's slot), second is fresh
      const newIds = spawnMany(storage, 2);

      // Both new entities are alive
      expect(alive(storage, newIds[0]!)).toBe(true);
      expect(alive(storage, newIds[1]!)).toBe(true);

      // Old id1 is stale, id2 and id3 are still alive
      expect(alive(storage, id1)).toBe(false);
      expect(alive(storage, id2)).toBe(true);
      expect(alive(storage, id3)).toBe(true);
    });

    it("produces no aliasing: all returned IDs are distinct and alive", () => {
      const world = createWorld();
      const Arch = archetype([Position]);
      const storage = register(world, Arch);

      // Despawn some entities to seed the freelist
      const old1 = spawnMany(storage, 1)[0]!;
      const old2 = spawnMany(storage, 1)[0]!;
      spawnMany(storage, 1); // retained entity — keeps archetype non-empty
      despawn(storage, old1);
      despawn(storage, old2);

      // spawnMany should produce distinct IDs (no duplicates)
      const newIds = spawnMany(storage, 4);

      // All returned IDs are alive
      for (const id of newIds) {
        expect(alive(storage, id)).toBe(true);
      }

      // All returned IDs are unique (no aliasing)
      const seen = new Set<number>();
      for (const id of newIds) {
        expect(seen.has(id)).toBe(false);
        seen.add(id);
      }
    });
  });

  it("returns truncated out buffer when count is 0", () => {
    const world = createWorld();
    const Arch = archetype([Position]);
    const storage = register(world, Arch);
    const buf = spawnMany(storage, 3);
    expect(buf).toHaveLength(3);

    const result = spawnMany(storage, 0, buf);

    expect(result).toBe(buf);
    expect(result).toHaveLength(0);
  });

  it("grows storage arrays when spawning beyond initial capacity", () => {
    const world = createWorld();
    const Arch = archetype([Position]);
    const storage = register(world, Arch);

    const ids = spawnMany(storage, 10);

    expect(ids).toHaveLength(10);
    for (const id of ids) {
      expect(alive(storage, id)).toBe(true);
    }
  });

  describe("3-arg out form", () => {
    it("writes spawned ids into an empty out buffer", () => {
      const world = createWorld();
      const Arch = archetype([Position]);
      const storage = register(world, Arch);
      const buf: EntityId[] = [];

      const result = spawnMany(storage, 3, buf);

      expect(result).toHaveLength(3);
      expect(result).toBe(buf); // same array reference
      for (const id of result) {
        expect(alive(storage, id)).toBe(true);
      }
    });

    it("clears tail when out buffer is larger than count", () => {
      const world = createWorld();
      const Arch = archetype([Position]);
      const storage = register(world, Arch);

      // Pre-populate buffer with 5 entities
      const buf = spawnMany(storage, 5);
      expect(buf).toHaveLength(5);

      // Now spawn only 2 into the same buffer — tail (indices 2-4) must be cleared
      const result = spawnMany(storage, 2, buf);

      // Result and buf should be the same array
      expect(result).toBe(buf);

      // First 2 entries should have new EntityIds and be alive
      expect(alive(storage, buf[0]!)).toBe(true);
      expect(alive(storage, buf[1]!)).toBe(true);

      // Tail entries cleared
      expect(buf).toHaveLength(2);
    });

    it("grows a non-empty out buffer that starts shorter than count", () => {
      const world = createWorld();
      const Arch = archetype([Position]);
      const storage = register(world, Arch);
      const buf = spawnMany(storage, 2);

      const result = spawnMany(storage, 5, buf);

      expect(result).toBe(buf);
      expect(result).toHaveLength(5);
      expect(new Set(result).size).toBe(5);
      for (const id of result) {
        expect(alive(storage, id)).toBe(true);
      }
    });

    it("fills out with the same ids the non-out overload returns for the same world state", () => {
      const expectedWorld = createWorld();
      const expectedStorage = register(expectedWorld, archetype([Position]));
      despawn(expectedStorage, spawnMany(expectedStorage, 2)[1]!);
      const expectedIds = spawnMany(expectedStorage, 3);

      const world = createWorld();
      const storage = register(world, archetype([Position]));
      despawn(storage, spawnMany(storage, 2)[1]!);
      const buf: EntityId[] = [];

      const ids = spawnMany(storage, 3, buf);

      expect(ids).toStrictEqual(expectedIds);
    });

    it("4-arg form works with overrides and out", () => {
      const world = createWorld();
      const Arch = archetype([Position, Shield]);
      const storage = register(world, Arch);
      const buf: EntityId[] = [];

      spawnMany(storage, 2, { [Position.__ecstatic_name]: { x: 99 } }, buf);

      expect(buf).toHaveLength(2);
      for (const id of buf) {
        expect(alive(storage, id)).toBe(true);
      }
    });

    it("3-arg overrides record still applies overrides", () => {
      const world = createWorld();
      const Arch = archetype([Position, Shield]);
      const storage = register(world, Arch);

      spawnMany(storage, 2, { [Position.__ecstatic_name]: { x: 42 } });

      const posSoa = storage.columns.get(Position)!;
      for (let i = 0; i < 2; i++) {
        expect(posSoa.x![i]).toBe(42);
      }
    });
  });

  describe("spawn range overflow", () => {
    it("overflow rejected atomically: fresh demand reaching MAX_INDEX errors before any mutation", () => {
      const world = createWorld();
      const Arch = archetype([Position]);
      const storage = register(world, Arch);

      // Simulate a world where nextIndex is already at the ceiling with no freelist.
      world.nextIndex = MAX_INDEX;
      world.freeHead = -1;

      // Snapshot world state before the call.
      const beforeN = storage.n;
      const beforeNextIndex = world.nextIndex;
      const beforeFreeHead = world.freeHead;

      // Act: spawnMany needs 3 fresh slots — overflows.
      expect(() => {
        spawnMany(storage, 3);
      }).toThrow();

      // World must be completely unchanged.
      expect(storage.n).toBe(beforeN);
      expect(world.nextIndex).toBe(beforeNextIndex);
      expect(world.freeHead).toBe(beforeFreeHead);
    });

    it("freelist-only near ceiling succeeds: reusing slots does not trigger the overflow guard", () => {
      const world = createWorld();
      const Arch = archetype([Position]);
      const storage = register(world, Arch);

      // Build a 2-slot freelist by spawning then despawning 2 entities.
      const tmp1 = spawnMany(storage, 1)[0]!;
      const tmp2 = spawnMany(storage, 1)[0]!;
      despawn(storage, tmp1);
      despawn(storage, tmp2);

      // Now push nextIndex to the ceiling — freelist reuse must still succeed.
      world.nextIndex = MAX_INDEX;

      // Act: spawn 2 — fits entirely in the freelist.
      expect(() => {
        spawnMany(storage, 2);
      }).not.toThrow();
      expect(storage.n).toBe(2);
    });

    it("mixed batch overflow rejected: freelist has 1 slot, fresh demand overflows, world unchanged", () => {
      const world = createWorld();
      const Arch = archetype([Position]);
      const storage = register(world, Arch);

      // Build a 1-slot freelist.
      const tmp = spawnMany(storage, 1)[0]!;
      despawn(storage, tmp);

      // Simulate nextIndex one step below the ceiling: 1 fresh slot is possible, but 2 are not.
      world.nextIndex = MAX_INDEX - 1;

      // Snapshot state.
      const beforeN = storage.n;
      const beforeNextIndex = world.nextIndex;
      const beforeFreeHead = world.freeHead;

      // Act: spawn 3 — freelist covers 1, needs 2 fresh → overflows.
      expect(() => {
        spawnMany(storage, 3);
      }).toThrow();

      // World must be completely unchanged.
      expect(storage.n).toBe(beforeN);
      expect(world.nextIndex).toBe(beforeNextIndex);
      expect(world.freeHead).toBe(beforeFreeHead);
    });

    it("mixed batch that fits succeeds: freelist has 1 slot, 2 fresh needed, nextIndex allows it", () => {
      const world = createWorld();
      const Arch = archetype([Position]);
      const storage = register(world, Arch);

      // Build a 1-slot freelist.
      const tmp = spawnMany(storage, 1)[0]!;
      despawn(storage, tmp);

      // Place nextIndex two steps below the ceiling: 2 fresh slots fit.
      world.nextIndex = MAX_INDEX - 2;

      // Act: spawn 3 — freelist covers 1, needs 2 fresh → fits.
      expect(() => {
        spawnMany(storage, 3);
      }).not.toThrow();
      expect(storage.n).toBe(3);
    });
  });
});
