import { assert, describe, expect, it } from "vitest";

import { MAX_INDEX } from "../../../src/ecstatic/entity-id.js";
import {
  archetype,
  components,
  despawn,
  type EntityId,
  get,
  getSources,
  has,
  ref,
  relation,
  spawn,
  spawnMany,
} from "../../../src/ecstatic/index.js";
import { createWorld, register, type World } from "../../../src/ecstatic/world.js";
import { despawnOnRead, rowOf } from "../fixtures.js";

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

    const pos = storage.columns.get(Position);

    assert(pos != null);
    const health = storage.columns.get(Health);
    assert(health != null);
    expect(pos["x"]?.[row]).toBe(0);
    expect(pos["y"]?.[row]).toBe(0);
    expect(health["hp"]?.[row]).toBe(100);
    expect(health["maxHp"]?.[row]).toBe(100);
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

    const pos = storage.columns.get(Position);

    assert(pos != null);
    const health = storage.columns.get(Health);
    assert(health != null);
    expect(pos["x"]?.[row]).toBe(42);
    expect(pos["y"]?.[row]).toBe(0);
    expect(health["hp"]?.[row]).toBe(50);
    expect(health["maxHp"]?.[row]).toBe(100);
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

    const pos = storage.columns.get(Position);

    assert(pos != null);
    const health = storage.columns.get(Health);
    assert(health != null);
    expect(pos["x"]?.[row]).toBe(42);
    expect(pos["y"]?.[row]).toBe(0);
    expect(health["hp"]?.[row]).toBe(100);
    expect(health["maxHp"]?.[row]).toBe(100);
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
    expect(storage.columns.get(Position)?.["x"]?.[row]).toBe(0);
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

  it("stores object override by reference (no clone)", () => {
    const { SpawnRefStats: Stats } = components({
      SpawnRefStats: { data: ref() },
    });
    const world = createWorld();
    const Arch = archetype([Stats]);
    const storage = register(world, Arch);

    const obj = { hp: 100 };
    spawn(storage, { [Stats.__ecstatic_name]: { data: obj } });

    const col = storage.columns.get(Stats);

    assert(col != null);
    expect(col["data"]?.[0]).toBe(obj);

    // Spawn without override reads undefined for ref field
    spawn(storage);
    expect(col["data"]?.[1]).toBeUndefined();
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

      const posCol = storage.columns.get(Position);
      assert(posCol != null);
      expect(posCol["x"]?.length).toBeGreaterThanOrEqual(10);
    });

    it("writes a required field override whose getter grows the storage, reading it once", () => {
      const world = createWorld();
      const storage = register(world, archetype([Position]));
      let reads = 0;
      const position = {
        get x(): number {
          reads += 1;
          spawnMany(storage, 16);
          return 42;
        },
      };

      const id = spawn(storage, { SpawnTestPosition: position });

      expect(get(storage, id, Position.x)).toBe(42);
      expect(reads).toBe(1);
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

      expect(storage.generation.length).toBeGreaterThanOrEqual(300);
      expect(storage.sparse.length).toBeGreaterThanOrEqual(300);
    });
  });
});

describe("override getters", () => {
  it("writes an override getter value that despawns an earlier sibling to the spawned row", () => {
    const { SpawnTestStunned: Stunned } = components({ SpawnTestStunned: {} });
    const world = createWorld();
    const storage = register(world, archetype([Position], [Stunned]));
    const sibling = spawn(storage);
    const position = despawnOnRead(storage, sibling, "x", 42);

    const id = spawn(storage, { SpawnTestPosition: position, SpawnTestStunned: true });

    expect(get(storage, id, Position.x)).toBe(42);
    expect(has(storage, id, Stunned)).toBe(true);
  });
});

describe("required relation override", () => {
  /** Builds a storage with a required relation and an override whose `target` names a live entity on its first read only. */
  function createReadOnceOwner() {
    const Owner = relation("SpawnReadOnceReq_Owner");
    const world = createWorld();
    const storage = register(world, archetype([Position, Owner]));
    const target = spawn(register(world, archetype([Position])));
    const counter = { reads: 0 };
    const owner = {
      get target(): EntityId {
        counter.reads += 1;
        // @ts-expect-error the types reject an undefined target; the getter returns one after its first read to catch a second read
        return counter.reads === 1 ? target : undefined;
      },
    };
    return { Owner, world, storage, target, counter, owner };
  }

  type ReadOnceOwner = ReturnType<typeof createReadOnceOwner>;

  it.each([
    {
      api: "spawn",
      act: ({ storage, owner }: ReadOnceOwner): EntityId[] => [
        spawn(storage, { SpawnReadOnceReq_Owner: owner }),
      ],
    },
    {
      api: "spawnMany",
      act: ({ storage, owner }: ReadOnceOwner): EntityId[] =>
        spawnMany(storage, 2, { SpawnReadOnceReq_Owner: owner }),
    },
  ])(
    "$api birth-links to the target its override held on the single read of `target`",
    ({ act }) => {
      const fixture = createReadOnceOwner();
      const { Owner, world, storage, target, counter } = fixture;

      const ids = act(fixture);

      expect(ids.map((id) => get(storage, id, Owner.target))).toStrictEqual(ids.map(() => target));
      expect(getSources(world, Owner, target)).toStrictEqual(ids);
      expect(counter.reads).toBe(1);
    },
  );
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
    world.nextIndex = MAX_INDEX;
    world.freeHead = -1; // force fresh-alloc path

    expect(() => {
      spawn(storage);
    }).toThrow(new RegExp(String(MAX_INDEX - 1)));
  });

  it("reports the per-world ceiling when spawning past 1,048,576 entities", () => {
    const world = createWorld();
    const storage = register(world, archetype([Position]));
    world.nextIndex = 1048576;
    world.freeHead = -1;

    expect(() => {
      spawn(storage);
    }).toThrow(new Error("entity index overflow (max 1048575 per world)"));
  });

  describe("when the spawn carries a relation override", () => {
    const RequiredOwner = relation("SpawnOverflowReq_Owner");
    const OptionalOwner = relation("SpawnOverflowOpt_Owner");

    type OwnerRecord = { target: EntityId };
    type BuildOwner = (world: World) => {
      Owner: typeof RequiredOwner | typeof OptionalOwner;
      storage: Parameters<typeof spawn>[0];
      spawnOwned: (record: () => OwnerRecord) => EntityId;
    };

    /** Builds a world at the index ceiling with an empty freelist, holding a live target and one entity to free later. */
    function createFullWorld(build: BuildOwner) {
      const world = createWorld();
      const target = spawn(register(world, archetype([Position])));
      const spare = spawn(register(world, archetype([Health])));
      const { Owner, storage, spawnOwned } = build(world);
      world.nextIndex = MAX_INDEX;
      world.freeHead = -1;
      const counter = { reads: 0 };
      const countedRecord = (): OwnerRecord => {
        counter.reads += 1;
        return {
          get target(): EntityId {
            counter.reads += 1;
            return target;
          },
        };
      };
      return { world, target, spare, Owner, storage, spawnOwned, counter, countedRecord };
    }

    const relationCases: { kind: string; build: BuildOwner }[] = [
      {
        kind: "required",
        build: (world) => {
          const storage = register(world, archetype([Position, RequiredOwner]));
          return {
            Owner: RequiredOwner,
            storage,
            spawnOwned: (record) =>
              spawn(storage, {
                get SpawnOverflowReq_Owner(): OwnerRecord {
                  return record();
                },
              }),
          };
        },
      },
      {
        kind: "optional",
        build: (world) => {
          const storage = register(world, archetype([Position], [OptionalOwner]));
          return {
            Owner: OptionalOwner,
            storage,
            spawnOwned: (record) =>
              spawn(storage, {
                get SpawnOverflowOpt_Owner(): OwnerRecord {
                  return record();
                },
              }),
          };
        },
      },
    ];

    it.each(relationCases)(
      "$kind relation: throws the overflow error without reading the override",
      ({ build }) => {
        const { spawnOwned, counter, countedRecord } = createFullWorld(build);

        expect(() => spawnOwned(countedRecord)).toThrow(
          new Error("entity index overflow (max 1048575 per world)"),
        );
        expect(counter.reads).toBe(0);
      },
    );

    it.each(relationCases)(
      "$kind relation: links a later spawn to its target once a slot is free again",
      ({ build }) => {
        const { world, target, spare, Owner, storage, spawnOwned } = createFullWorld(build);
        expect(() => spawnOwned(() => ({ target }))).toThrow(new RegExp(String(MAX_INDEX - 1)));
        despawn(world, spare);

        const id = spawnOwned(() => ({ target }));

        expect(get(storage, id, Owner.target)).toBe(target);
        expect(getSources(world, Owner, target)).toStrictEqual([id]);
      },
    );
  });
});
