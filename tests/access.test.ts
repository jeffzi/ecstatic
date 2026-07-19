import { describe, expect, it } from "vitest";

import {
  archetype,
  component,
  components,
  createWorld,
  despawn,
  get,
  ref,
  register,
  set,
  spawn,
} from "../src/index.js";

// Use unique prefixes to avoid collisions with other test files
const { AccessPos: Position } = components({
  AccessPos: { x: 0, y: 0 },
});

const { AccessVel: Velocity } = components({
  AccessVel: { vx: 0, vy: 0 },
});

const { AccessHp: Health } = components({
  AccessHp: { hp: 100 },
});

describe("get", () => {
  it("returns the current field value", () => {
    const world = createWorld();
    const Arch = archetype([Position]);
    const storage = register(world, Arch);
    const id = spawn(storage, { [Position.__ecstatic_name]: { x: 7, y: 3 } });

    expect(get(storage, id, Position.x)).toBe(7);
    expect(get(storage, id, Position.y)).toBe(3);
  });

  it("errors on a stale (despawned) entity ID", () => {
    const world = createWorld();
    const Arch = archetype([Health]);
    const storage = register(world, Arch);
    const id = spawn(storage);
    despawn(storage, id);

    expect(() => {
      get(storage, id, Health.hp);
    }).toThrow();
  });

  it("errors if component is not on this archetype", () => {
    const world = createWorld();
    const Arch = archetype([Position]);
    const storage = register(world, Arch);
    const id = spawn(storage);

    expect(() => {
      get(storage, id, Velocity.vx);
    }).toThrow();
  });

  it("errors when the ID belongs to a different storage in the same world", () => {
    const world = createWorld();
    const storage1 = register(world, archetype([Position]));
    const storage2 = register(world, archetype([Velocity]));
    const id = spawn(storage1);

    expect(() => {
      get(storage2, id, Velocity.vx);
    }).toThrow();
  });
});

describe("set", () => {
  it("writes a single field and leaves others unchanged", () => {
    const world = createWorld();
    const Arch = archetype([Position]);
    const storage = register(world, Arch);
    const id = spawn(storage);

    set(storage, id, Position, { x: 42 });
    expect(get(storage, id, Position.x)).toBe(42);
    expect(get(storage, id, Position.y)).toBe(0);
  });

  it("round-trips values through get", () => {
    const world = createWorld();
    const Arch = archetype([Position]);
    const storage = register(world, Arch);
    const id = spawn(storage);

    set(storage, id, Position, { x: 15, y: 20 });
    expect(get(storage, id, Position.x)).toBe(15);
    expect(get(storage, id, Position.y)).toBe(20);
  });

  it("errors on a stale entity ID", () => {
    const world = createWorld();
    const Arch = archetype([Health]);
    const storage = register(world, Arch);
    const id = spawn(storage);
    despawn(storage, id);

    expect(() => {
      set(storage, id, Health, { hp: 50 });
    }).toThrow();
  });

  it("errors if component is not on this archetype", () => {
    const world = createWorld();
    const Arch = archetype([Position]);
    const storage = register(world, Arch);
    const id = spawn(storage);

    expect(() => {
      set(storage, id, Velocity, { vx: 1 });
    }).toThrow();
  });
});

describe("resolveFieldColumn errors", () => {
  it("errors when component has no data fields (optional tag)", () => {
    const AccessTag = component("AccessTag");
    const world = createWorld();
    const Arch = archetype([Position], [AccessTag]);
    const storage = register(world, Arch);
    const id = spawn(storage);

    expect(() => {
      get(storage, id, { __ecstatic_component: AccessTag, __ecstatic_field: "x" });
    }).toThrow("has no data fields");
  });

  it("errors on unknown field name", () => {
    const world = createWorld();
    const Arch = archetype([Position]);
    const storage = register(world, Arch);
    const id = spawn(storage);

    expect(() => {
      get(storage, id, { __ecstatic_component: Position, __ecstatic_field: "z" });
    }).toThrow("unknown field");
  });
});

describe("multi-world isolation", () => {
  it("mutations in world1 do not affect world2 storage", () => {
    const world1 = createWorld();
    const world2 = createWorld();

    const Arch = archetype([Position]);
    const storage1 = register(world1, Arch);
    const storage2 = register(world2, Arch);

    const id1 = spawn(storage1);
    spawn(storage2);

    set(storage1, id1, Position, { x: 99 });

    const col1 = storage1.columns.get(Position)!;
    const col2 = storage2.columns.get(Position)!;

    expect(col1.x![0]).toBe(99);
    expect(col2.x![0]).toBe(0);
  });

  it("operations resolve IDs against the storage passed to the operation", () => {
    const world1 = createWorld();
    const world2 = createWorld();

    const Arch = archetype([Health]);
    const storage1 = register(world1, Arch);
    const storage2 = register(world2, Arch);

    const id1 = spawn(storage1, { [Health.__ecstatic_name]: { hp: 10 } });
    spawn(storage2, { [Health.__ecstatic_name]: { hp: 20 } });

    set(storage2, id1, Health, { hp: 50 });

    expect(get(storage1, id1, Health.hp)).toBe(10);
    expect(get(storage2, id1, Health.hp)).toBe(50);
  });
});

describe("ref field semantics", () => {
  it("ref field reads nil before first set", () => {
    const { RefNilRead: RefComp } = components({
      RefNilRead: { handle: ref() },
    });

    const world = createWorld();
    const Arch = archetype([RefComp]);
    const storage = register(world, Arch);
    spawn(storage);

    const soa = storage.columns.get(RefComp)!;
    expect(soa.handle![0]).toBeUndefined();
  });

  it("set(storage, id, field, undefined) clears a ref field", () => {
    const { RefClear: RefComp } = components({
      RefClear: { handle: ref() },
    });

    const world = createWorld();
    const Arch = archetype([RefComp]);
    const storage = register(world, Arch);
    const id = spawn(storage, {
      [RefComp.__ecstatic_name]: { handle: { x: 1 } },
    });

    set(storage, id, RefComp.handle, undefined);

    const soa = storage.columns.get(RefComp)!;
    expect(soa.handle![0]).toBeUndefined();
  });

  it("get returns ref field value when set", () => {
    const { RefGet: RefComp } = components({
      RefGet: { target: ref() },
    });

    const world = createWorld();
    const Arch = archetype([RefComp]);
    const storage = register(world, Arch);
    const testRef = { id: 42 };
    const id = spawn(storage, {
      [RefComp.__ecstatic_name]: { target: testRef },
    });

    expect(get(storage, id, RefComp.target)).toStrictEqual(testRef);
  });
});

describe("get/set world form", () => {
  it("get(world, id, field) returns field value for entity in any archetype", () => {
    const world = createWorld();
    const storage = register(world, archetype([Position]));
    const id = spawn(storage, { [Position.__ecstatic_name]: { x: 7, y: 3 } });

    expect(get(world, id, Position.x)).toBe(7);
    expect(get(world, id, Position.y)).toBe(3);
  });

  it("set(world, id, field, value) writes field value for entity in any archetype", () => {
    const world = createWorld();
    const storage = register(world, archetype([Position]));
    const id = spawn(storage);

    set(world, id, Position.x, 99);

    expect(get(world, id, Position.x)).toBe(99);
  });

  it("get errors on a stale entity ID", () => {
    const world = createWorld();
    const storage = register(world, archetype([Health]));
    const id = spawn(storage);
    despawn(storage, id);

    expect(() => {
      get(world, id, Health.hp);
    }).toThrow();
  });

  it("set errors on a stale entity ID", () => {
    const world = createWorld();
    const storage = register(world, archetype([Health]));
    const id = spawn(storage);
    despawn(storage, id);

    expect(() => {
      set(world, id, Health.hp, 42);
    }).toThrow();
  });
});

describe("boolean fields", () => {
  it("boolean fields round-trip as booleans", () => {
    const { BoolComp: Comp } = components({
      BoolComp: { active: false, enabled: true },
    });

    const world = createWorld();
    const Arch = archetype([Comp]);
    const storage = register(world, Arch);
    const id = spawn(storage);

    set(storage, id, Comp, { active: true, enabled: false });
    expect(get(storage, id, Comp.active)).toBe(true);
    expect(get(storage, id, Comp.enabled)).toBe(false);
  });

  it("boolean set with true/false stores as 1/0 and reads back as true/false", () => {
    const { BoolRoundtrip: Comp } = components({
      BoolRoundtrip: { flag: false },
    });

    const world = createWorld();
    const Arch = archetype([Comp]);
    const storage = register(world, Arch);
    const id = spawn(storage);

    // Set via field descriptor
    set(storage, id, Comp.flag, true);
    expect(get(storage, id, Comp.flag)).toBe(true);

    set(storage, id, Comp.flag, false);
    expect(get(storage, id, Comp.flag)).toBe(false);
  });
});
