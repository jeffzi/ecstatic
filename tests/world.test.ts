import { describe, expect, it } from "vitest";

import { archetype, components, i32, ref } from "../src/index.js";
import { createWorld, getStorage, register } from "../src/world.js";

// Use WorldTest-prefixed names to avoid any collision with other spec files.
const { WorldTestPosition: Position } = components({
  WorldTestPosition: { x: 0, y: 0 },
});
const { WorldTestVelocity: Velocity } = components({
  WorldTestVelocity: { vx: 0, vy: 0 },
});
const { WorldTestHealth: Health } = components({
  WorldTestHealth: { hp: 100 },
});

describe("register", () => {
  it("creates SOA arrays for each component field", () => {
    const world = createWorld();
    const Arch = archetype([Position, Velocity]);
    const storage = register(world, Arch);

    const posCol = storage.columns.get(Position)!;
    expect(posCol).toBeDefined();
    expect(posCol.x).toBeDefined();
    expect(posCol.y).toBeDefined();
    expect(posCol.x).toBeInstanceOf(Float64Array);
    expect(posCol.y).toBeInstanceOf(Float64Array);

    const velCol = storage.columns.get(Velocity)!;
    expect(velCol).toBeDefined();
    expect(velCol.vx).toBeDefined();
    expect(velCol.vy).toBeDefined();
  });

  it("starts with zero entities", () => {
    const world = createWorld();
    const Arch = archetype([Position]);
    const storage = register(world, Arch);

    expect(storage.n).toBe(0);
  });

  it("stores component list in order", () => {
    const world = createWorld();
    const Arch = archetype([Position, Velocity, Health]);
    const storage = register(world, Arch);

    expect(storage.archetype.components).toHaveLength(3);
    expect(storage.archetype.components[0]).toBe(Position);
    expect(storage.archetype.components[1]).toBe(Velocity);
    expect(storage.archetype.components[2]).toBe(Health);
  });
});

describe("world", () => {
  it("ignores duplicate registration (idempotent)", () => {
    const world = createWorld();
    const Arch = archetype([Position]);
    const storage1 = register(world, Arch);
    const storageCount1 = storage1.n;

    const storage2 = register(world, Arch);

    expect(storage1).toBe(storage2);
    expect(storage2.n).toBe(storageCount1);
  });
});

describe("getStorage", () => {
  it("returns the registered storage", () => {
    const world = createWorld();
    const Arch = archetype([Position]);
    const storage = register(world, Arch);

    const retrieved = getStorage(world, Arch);
    expect(retrieved).toBe(storage);
  });

  it("throws on unregistered archetype in this world", () => {
    const world = createWorld();
    const Arch = archetype([Position]);

    expect(() => {
      getStorage(world, Arch);
    }).toThrow(/archetype not registered in this world/);
  });
});

describe("multi-world register", () => {
  it("allows the same archetype to be registered in two independent worlds", () => {
    const world1 = createWorld();
    const world2 = createWorld();
    const Arch = archetype([Velocity]);

    expect(() => {
      register(world1, Arch);
      register(world2, Arch);
    }).not.toThrow();

    const storage1 = getStorage(world1, Arch);
    const storage2 = getStorage(world2, Arch);
    expect(storage1).not.toBe(storage2);
  });
});

describe("column construction", () => {
  it("creates Float64Array columns for plain number fields", () => {
    const { PlainNum: Comp } = components({
      PlainNum: { x: 0 },
    });
    const world = createWorld();
    const Arch = archetype([Comp]);
    const storage = register(world, Arch);

    const col = storage.columns.get(Comp)!.x;
    expect(col).toBeInstanceOf(Float64Array);
  });

  it("creates Uint8Array columns for boolean fields", () => {
    const { BoolComp: Comp } = components({
      BoolComp: { active: false },
    });
    const world = createWorld();
    const Arch = archetype([Comp]);
    const storage = register(world, Arch);

    const col = storage.columns.get(Comp)!.active;
    expect(col).toBeInstanceOf(Uint8Array);
  });

  it("creates plain Array for ref fields", () => {
    const { refComp: Comp } = components({
      refComp: { target: ref() },
    });
    const world = createWorld();
    const Arch = archetype([Comp]);
    const storage = register(world, Arch);

    const col = storage.columns.get(Comp)!.target;
    expect(Array.isArray(col)).toBe(true);
  });

  it("respects width markers for TypedArray selection", () => {
    const { i32Comp: Comp } = components({
      i32Comp: { count: i32(0) },
    });
    const world = createWorld();
    const Arch = archetype([Comp]);
    const storage = register(world, Arch);

    const col = storage.columns.get(Comp)!.count;
    expect(col).toBeInstanceOf(Int32Array);
  });
});

describe("named SoA aliases", () => {
  it("provides named SoA aliases on storage", () => {
    const world = createWorld();
    const Arch = archetype([Position]);
    const storage = register(world, Arch);

    expect(storage.WorldTestPosition).toBeDefined();
    expect(storage).toHaveProperty("WorldTestPosition.x");
    expect(storage).toHaveProperty("WorldTestPosition.y");
  });
});

describe("world-array aliases", () => {
  it("provides generation array alias on storage", () => {
    const world = createWorld();
    const Arch = archetype([Position]);
    const storage = register(world, Arch);

    expect(storage.generation).toBeDefined();
    expect(storage.generation).toBeInstanceOf(Float64Array);
  });

  it("provides sparse array alias on storage", () => {
    const world = createWorld();
    const Arch = archetype([Position]);
    const storage = register(world, Arch);

    expect(storage.sparse).toBeDefined();
    expect(storage.sparse).toBeInstanceOf(Int32Array);
  });
});

describe("mask initialization", () => {
  it("initializes mask as Uint32Array", () => {
    const world = createWorld();
    const Arch = archetype([Position]);
    const storage = register(world, Arch);

    expect(storage.mask).toBeDefined();
    expect(storage.mask).toBeInstanceOf(Uint32Array);
  });
});

describe("optional components with fields", () => {
  it("creates columns for optional components with data fields", () => {
    const { OptionalComp: Opt } = components({
      OptionalComp: { optVal: 0 },
    });
    const world = createWorld();
    const Arch = archetype([Position], [Opt]);
    const storage = register(world, Arch);

    const optCol = storage.columns.get(Opt);
    expect(optCol).toBeDefined();
    expect(optCol?.optVal).toBeInstanceOf(Float64Array);
  });

  it("skips columns for optional tag components (no fields)", () => {
    const { OptionalTag: OptTag } = components({ OptionalTag: {} });
    const world = createWorld();
    const Arch = archetype([Position], [OptTag]);
    const storage = register(world, Arch);

    const tagCol = storage.columns.get(OptTag);
    expect(tagCol).toBeUndefined();
  });

  it("provides named alias for optional components with fields", () => {
    const { OptWithAlias: Opt } = components({
      OptWithAlias: { value: 0 },
    });
    const world = createWorld();
    const Arch = archetype([Position], [Opt]);
    const storage = register(world, Arch);

    expect(storage.OptWithAlias).toBeDefined();
    expect(storage).toHaveProperty("OptWithAlias.value", expect.any(Float64Array));
  });
});
