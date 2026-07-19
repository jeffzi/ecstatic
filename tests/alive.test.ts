import { describe, expect, it } from "vitest";
import { alive, archetype, components, type EntityId, spawn } from "../src/index.js";
import { createWorld, register } from "../src/world.js";

const { AliveTestPosition: Position } = components({
  AliveTestPosition: { x: 0, y: 0 },
});
const { AliveTestHealth: Health } = components({
  AliveTestHealth: { hp: 100, maxHp: 100 },
});

describe("alive", () => {
  it("the same numeric ID can be alive in two worlds", () => {
    const world1 = createWorld();
    const world2 = createWorld();
    const Arch = archetype([Health]);

    const storage1 = register(world1, Arch);
    const storage2 = register(world2, Arch);

    const id1 = spawn(storage1);
    const id2 = spawn(storage2);

    expect(id1).toBe(id2);
    expect(alive(storage1, id1)).toBe(true);
    expect(alive(storage2, id1)).toBe(true);
  });

  it("alive works across storages in the same world", () => {
    const world = createWorld();
    const Arch1 = archetype([Position]);
    const Arch2 = archetype([Health]);

    const storage1 = register(world, Arch1);
    const storage2 = register(world, Arch2);

    const id = spawn(storage1);

    expect(alive(storage1, id)).toBe(true);
    expect(alive(storage2, id)).toBe(true);
  });

  it("returns false for never-allocated entity IDs", () => {
    const world = createWorld();
    const Arch = archetype([Position]);
    const storage = register(world, Arch);

    // A never-allocated ID should have generation 0 which won't match
    // Cast fabricates an invalid branded ID on purpose
    const neverAllocatedId = 999999 as EntityId;
    expect(alive(storage, neverAllocatedId)).toBe(false);
  });
});
