import { assert, describe, expect, it } from "vitest";

import { entityIndex, initialEntityId, MAX_GEN, MAX_INDEX } from "../../../src/entity-id.js";
import { ERROR_STALE_ENTITY_ID } from "../../../src/errors.js";
import {
  alive,
  archetype,
  components,
  despawn,
  despawnMany,
  get,
  ref,
  spawn,
  spawnMany,
} from "../../../src/index.js";
import { createWorld, register } from "../../../src/world.js";

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

    const pos = storage.columns.get(Position);

    assert(pos != null);
    // Dense row 0: original entity (10,20)
    expect(pos["x"]?.[0]).toBe(10);
    expect(pos["y"]?.[0]).toBe(20);
    // Dense row 1: swapped-in entity (50,60)
    expect(pos["x"]?.[1]).toBe(50);
    expect(pos["y"]?.[1]).toBe(60);
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
  it("errors under DEBUG when a live ID is despawned through the wrong storage #checked", () => {
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

    const ceilingId = ((MAX_GEN - 1) * MAX_INDEX + index) as typeof id;
    world.generation[index] = ceilingId;
    storage.entities[0] = ceilingId;
    despawn(storage, ceilingId);

    // The recycled slot restarts at generation 1 instead of overflowing.
    expect(spawn(storage)).toBe(initialEntityId(index));
  });

  it("reissues a slot's first id after 1,023 distinct ids", () => {
    const world = createWorld();
    const storage = register(world, archetype([Position]));
    const issued: number[] = [];

    for (let i = 0; i < 1023; i++) {
      const id = spawn(storage);
      issued.push(id);
      despawn(storage, id);
    }
    const reissued = spawn(storage);

    expect(new Set(issued).size).toBe(1023);
    expect(reissued).toBe(issued[0]);
    expect(alive(storage, reissued)).toBe(true);
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

    const col = storage.columns.get(RefComp);

    assert(col != null);
    // After swap-pop, tail slot (index 1) must be cleared to release the ref
    expect(col["handle"]?.[1]).toBeUndefined();
  });

  it("world-form despawn is a no-op when entityArch[index] is unset", () => {
    const world = createWorld();
    const Arch = archetype([Position]);
    const storage = register(world, Arch);
    const id = spawn(storage);

    // Manually clear entityArch to simulate the branch
    const index = entityIndex(id);
    world.entityArch[index] = undefined;

    expect(() => {
      despawn(world, id);
    }).not.toThrow();
    expect(storage.n).toBe(1);
  });
});

/** Number of distinct generations a slot hands out before its ids repeat. */
const SLOT_GENERATIONS = MAX_GEN - 1;

/**
 * World with one bystander entity and a slot one despawn away from wrapping.
 *
 * `held` is the first id the slot issued. The slot has since been despawned and
 * respawned until `occupant`, its live entity, carries the last generation:
 * freeing `occupant` is the slot's 1,023rd despawn, after which the slot's next
 * id is `held` again.
 */
function createWrappingSlot() {
  const world = createWorld();
  const storage = register(world, archetype([Position]));
  const bystander = spawn(storage, { DespawnTestPosition: { x: 10, y: 20 } });
  const held = spawn(storage);
  let occupant = held;
  for (let i = 1; i < SLOT_GENERATIONS; i++) {
    despawn(storage, occupant);
    occupant = spawn(storage);
  }
  return { bystander, held, occupant, storage, world };
}

type WrappingSlot = ReturnType<typeof createWrappingSlot>;

/** {@link createWrappingSlot} with the slot freed, so no entity exists for `held`. */
function createWrappedFreeSlot(): WrappingSlot {
  const fixture = createWrappingSlot();
  despawn(fixture.storage, fixture.occupant);
  return fixture;
}

interface SlotCase {
  readonly label: string;
  readonly run: (fixture: WrappingSlot) => void;
}

describe("an id whose slot is free after the generation wraps", () => {
  it.each<SlotCase>([
    {
      label: "despawn",
      run: ({ occupant, storage }) => {
        despawn(storage, occupant);
      },
    },
    {
      label: "despawnMany with ids",
      run: ({ occupant, storage }) => {
        despawnMany(storage, [occupant]);
      },
    },
    {
      label: "despawnMany over a storage",
      run: ({ storage }) => {
        despawnMany(storage);
      },
    },
    {
      label: "despawnMany over a world with ids",
      run: ({ occupant, world }) => {
        despawnMany(world, [occupant]);
      },
    },
    {
      label: "despawnMany over a world",
      run: ({ world }) => {
        despawnMany(world);
      },
    },
  ])("is not alive once $label frees the slot", ({ run }) => {
    const fixture = createWrappingSlot();

    run(fixture);

    expect(alive(fixture.world, fixture.held)).toBe(false);
    expect(alive(fixture.storage, fixture.held)).toBe(false);
  });

  it.each<SlotCase>([
    {
      label: "storage",
      run: ({ held, storage }) => {
        despawn(storage, held);
      },
    },
    {
      label: "world",
      run: ({ held, world }) => {
        despawn(world, held);
      },
    },
  ])("is a no-op to despawn through the $label", ({ run }) => {
    const fixture = createWrappedFreeSlot();
    const { bystander, storage } = fixture;

    expect(() => {
      run(fixture);
    }).not.toThrow();
    expect(storage.n).toBe(1);
    expect(alive(storage, bystander)).toBe(true);
    expect(get(storage, bystander, Position.x)).toBe(10);
    expect(get(storage, bystander, Position.y)).toBe(20);
    expect(spawn(storage)).not.toBe(spawn(storage));
  });

  it.each<SlotCase>([
    {
      label: "storage",
      run: ({ held, storage }) => {
        get(storage, held, Position.x);
      },
    },
    {
      label: "world",
      run: ({ held, world }) => {
        get(world, held, Position.x);
      },
    },
  ])("is stale to get through the $label #checked", ({ run }) => {
    const fixture = createWrappedFreeSlot();

    expect(() => {
      run(fixture);
    }).toThrow(ERROR_STALE_ENTITY_ID);
  });

  it("is reissued, alive, when spawnMany takes the slot", () => {
    const { held, storage } = createWrappedFreeSlot();

    const [reissued] = spawnMany(storage, 1);

    expect(reissued).toBe(held);
    expect(alive(storage, held)).toBe(true);
  });
});
