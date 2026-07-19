import { describe, expect, it } from "vitest";

import { alive, archetype, components, destroyWorld, getStorage, spawn } from "../src/index.js";
import { createWorld, register } from "../src/world.js";

const { DestroyWorldTestPosition: Position } = components({
  DestroyWorldTestPosition: { x: 0, y: 0 },
});

const { DestroyWorldTestVelocity: Velocity } = components({
  DestroyWorldTestVelocity: { vx: 0, vy: 0 },
});

describe("destroyWorld", () => {
  it("empties all registered storages", () => {
    const world = createWorld();
    const Arch1 = archetype([Position]);
    const Arch2 = archetype([Position, Velocity]);
    const storage1 = register(world, Arch1);
    const storage2 = register(world, Arch2);

    spawn(storage1);
    spawn(storage1);
    spawn(storage2);
    spawn(storage2);
    spawn(storage2);

    expect(storage1.n).toBe(2);
    expect(storage2.n).toBe(3);

    destroyWorld(world);

    expect(storage1.n).toBe(0);
    expect(storage2.n).toBe(0);
    // Storages are disconnected from the destroyed world
    expect(storage1.world).toBeUndefined();
    expect(storage2.world).toBeUndefined();
  });

  it("invalidates previously alive entity IDs", () => {
    const world = createWorld();
    const Arch = archetype([Position]);
    const storage = register(world, Arch);

    const id = spawn(storage);

    expect(alive(storage, id)).toBe(true);

    destroyWorld(world);

    expect(alive(storage, id)).toBe(false);
  });

  it("world form alive returns false after destroyWorld", () => {
    const world = createWorld();
    const Arch = archetype([Position]);
    const storage = register(world, Arch);
    const id = spawn(storage);

    expect(alive(world, id)).toBe(true);

    destroyWorld(world);

    expect(alive(world, id)).toBe(false);
  });
});

describe("destroyed world guards", () => {
  it("register errors on destroyed world", () => {
    const world = createWorld();
    const Arch = archetype([Position]);
    register(world, Arch);

    destroyWorld(world);

    expect(() => {
      register(world, Arch);
    }).toThrow();
  });

  it("getStorage errors on destroyed world", () => {
    const world = createWorld();
    const Arch = archetype([Position]);
    const storage = register(world, Arch);

    destroyWorld(world);

    expect(() => {
      getStorage(world, storage.archetype);
    }).toThrow();
  });

  it("is a no-op when destroyWorld is called twice", () => {
    const world = createWorld();
    const Arch = archetype([Position]);
    register(world, Arch);

    destroyWorld(world);

    expect(() => {
      destroyWorld(world);
    }).not.toThrow();
  });
});
