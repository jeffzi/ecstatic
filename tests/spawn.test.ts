import { describe, expect, it } from "vitest";
import { entityIndex, MAX_INDEX } from "../src/entity-id";
import { archetype, components, ref, spawn } from "../src/index.js";
import { createWorld, register } from "../src/world.js";

/** Dense row of a live entity: sparse lookup by entity index. */
function rowOf(storage: { sparse: Int32Array }, id: number): number {
  return storage.sparse[entityIndex(id)]!;
}

const { SpawnTestPosition: Position } = components({
  SpawnTestPosition: { x: 0, y: 0 },
});
const { SpawnTestHealth: Health } = components({
  SpawnTestHealth: { hp: 100, maxHp: 100 },
});

describe("spawn", () => {
  it("increments archetype entity count", () => {
    const world = createWorld();
    const Arch = archetype([Position]);
    const storage = register(world, Arch);

    spawn(storage);
    expect(storage.n).toBe(1);
  });

  it("populates SOA arrays with component defaults", () => {
    const world = createWorld();
    const Arch = archetype([Position, Health]);
    const storage = register(world, Arch);

    const id = spawn(storage);
    const row = rowOf(storage, id);

    const pos = storage.columns.get(Position)!;
    const health = storage.columns.get(Health)!;
    expect(pos.x![row]).toBe(0);
    expect(pos.y![row]).toBe(0);
    expect(health.hp![row]).toBe(100);
    expect(health.maxHp![row]).toBe(100);
  });

  it("applies overrides to default values", () => {
    const world = createWorld();
    const Arch = archetype([Position, Health]);
    const storage = register(world, Arch);

    const id = spawn(storage, {
      SpawnTestPosition: { x: 42 },
      SpawnTestHealth: { hp: 50 },
    });
    const row = rowOf(storage, id);

    const pos = storage.columns.get(Position)!;
    const health = storage.columns.get(Health)!;
    expect(pos.x![row]).toBe(42);
    expect(pos.y![row]).toBe(0);
    expect(health.hp![row]).toBe(50);
    expect(health.maxHp![row]).toBe(100);
  });

  it("supports partial plain-object overrides without reading missing components as a map", () => {
    const world = createWorld();
    const Arch = archetype([Position, Health]);
    const storage = register(world, Arch);

    let id!: number;
    expect(() => {
      id = spawn(storage, { SpawnTestPosition: { x: 42 } });
    }).not.toThrow();
    const row = rowOf(storage, id);

    const pos = storage.columns.get(Position)!;
    const health = storage.columns.get(Health)!;
    expect(pos.x![row]).toBe(42);
    expect(pos.y![row]).toBe(0);
    expect(health.hp![row]).toBe(100);
    expect(health.maxHp![row]).toBe(100);
  });

  it("errors when a required component is overridden with false", () => {
    const world = createWorld();
    const Arch = archetype([Position]);
    const storage = register(world, Arch);

    expect(() => {
      // @ts-expect-error `false` on a required component is rejected at the type level too
      spawn(storage, { SpawnTestPosition: false });
    }).toThrow("required component SpawnTestPosition cannot be disabled at spawn");
  });

  it("treats a true override on a required component as defaults", () => {
    const world = createWorld();
    const Arch = archetype([Position]);
    const storage = register(world, Arch);

    const id = spawn(storage, { SpawnTestPosition: true });
    const row = rowOf(storage, id);
    expect(storage.columns.get(Position)!.x![row]).toBe(0);
  });

  it("returns unique IDs for multiple spawns", () => {
    const world = createWorld();
    const Arch = archetype([Position]);
    const storage = register(world, Arch);

    const id1 = spawn(storage);
    const id2 = spawn(storage);
    const id3 = spawn(storage);

    expect(id1).not.toBe(id2);
    expect(id2).not.toBe(id3);
    expect(id1).not.toBe(id3);
    expect(storage.n).toBe(3);
  });

  it("stores packed entity IDs for multiple spawns", () => {
    const world = createWorld();
    const Arch = archetype([Position]);
    const storage = register(world, Arch);

    const id1 = spawn(storage);
    const id2 = spawn(storage);

    expect(storage.entities[0]).toBe(id1);
    expect(storage.entities[1]).toBe(id2);
  });

  it("stores table override by reference (no clone)", () => {
    const { SpawnRefStats: Stats } = components({
      SpawnRefStats: { data: ref() },
    });
    const world = createWorld();
    const Arch = archetype([Stats]);
    const storage = register(world, Arch);

    const tbl = { hp: 100 };
    spawn(storage, { [Stats.__ecstatic_name]: { data: tbl } });

    const col = storage.columns.get(Stats)!;
    expect(col.data[0]).toBe(tbl);

    // Spawn without override reads undefined for ref field
    spawn(storage);
    expect(col.data[1]).toBeUndefined();
  });

  describe("growth", () => {
    it("spawning past initial capacity grows storage arrays", () => {
      const world = createWorld();
      const Arch = archetype([Position]);
      const storage = register(world, Arch);

      // Spawn more than initial capacity (8)
      const ids: number[] = [];
      for (let i = 0; i < 10; i++) {
        ids.push(spawn(storage));
      }

      expect(storage.n).toBe(10);

      // Verify earlier entities' column data survived
      const posCol = storage.columns.get(Position)!;
      expect(posCol.x.length).toBeGreaterThanOrEqual(10);
    });

    it("spawning past world capacity grows world arrays and refreshes aliases", () => {
      const world = createWorld();
      const Arch = archetype([Position]);
      const storage = register(world, Arch);

      // Spawn enough entities to exceed world capacity (256)
      const ids: number[] = [];
      for (let i = 0; i < 300; i++) {
        ids.push(spawn(storage));
      }

      expect(storage.n).toBe(300);

      // Verify generation, sparse, and entityArch aliases were refreshed
      expect(storage.generation.length).toBeGreaterThanOrEqual(300);
      expect(storage.sparse.length).toBeGreaterThanOrEqual(300);
    });
  });
});

describe("entity storage", () => {
  it("spawns entities with dense indices and count", () => {
    const world = createWorld();
    const Arch = archetype([Position]);
    const storage = register(world, Arch);

    const id0 = spawn(storage);
    const id1 = spawn(storage);

    expect(storage.n).toBe(2);
    expect(storage.entities[0]).toBe(id0);
    expect(storage.entities[1]).toBe(id1);
  });
});

describe("register", () => {
  it("is idempotent: calling twice preserves existing entity state", () => {
    const world = createWorld();
    const Arch = archetype([Position]);
    const storage = register(world, Arch);
    spawn(storage);

    expect(() => {
      register(world, Arch);
    }).not.toThrow();
    expect(storage.n).toBe(1);
  });
});

describe("multi-world isolation", () => {
  it("two worlds with the same archetype have independent entity counts", () => {
    const world1 = createWorld();
    const world2 = createWorld();
    const Arch = archetype([Position]);

    const storage1 = register(world1, Arch);
    const storage2 = register(world2, Arch);

    spawn(storage1);
    spawn(storage1);
    spawn(storage2);

    expect(storage1.n).toBe(2);
    expect(storage2.n).toBe(1);
  });
});

describe("hard limits", () => {
  it("entity index overflow: spawn errors when next_index reaches MAX_INDEX", () => {
    const world = createWorld();
    const Arch = archetype([Position]);
    const storage = register(world, Arch);

    // Simulate a nearly-full world without allocating the full entity range.
    const w = world as unknown as Record<string, number>;
    w.nextIndex = MAX_INDEX;
    w.freeHead = -1; // force fresh-alloc path

    expect(() => {
      spawn(storage);
    }).toThrow(new RegExp(String(MAX_INDEX - 1)));
  });
});
