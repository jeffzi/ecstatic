import { assert, describe, expect, it } from "vitest";

import {
  archetype,
  component,
  components,
  createWorld,
  despawn,
  enable,
  get,
  ref,
  register,
  relation,
  set,
  spawn,
} from "../../../src/ecstatic/index.js";
import { despawnOnRead } from "../fixtures.js";

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

  it("errors on a stale (despawned) entity ID #checked", () => {
    const world = createWorld();
    const Arch = archetype([Health]);
    const storage = register(world, Arch);
    const id = spawn(storage);
    despawn(storage, id);

    expect(() => {
      get(storage, id, Health.hp);
    }).toThrow("stale entity ID");
  });

  it("errors if component is not on this archetype", () => {
    const world = createWorld();
    const Arch = archetype([Position]);
    const storage = register(world, Arch);
    const id = spawn(storage);

    expect(() => {
      get(storage, id, Velocity.vx);
    }).toThrow("not on this archetype");
  });

  it("errors when the ID belongs to a different storage in the same world #checked", () => {
    const world = createWorld();
    const storage1 = register(world, archetype([Position]));
    const storage2 = register(world, archetype([Velocity]));
    const id = spawn(storage1);

    expect(() => {
      get(storage2, id, Velocity.vx);
    }).toThrow("entity ID does not belong to this storage");
  });

  describe("when field descriptor is invalid", () => {
    it("errors when component has no data fields (enabled optional tag)", () => {
      const AccessTag = component("AccessTag");
      const world = createWorld();
      const Arch = archetype([Position], [AccessTag]);
      const storage = register(world, Arch);
      const id = spawn(storage);
      // Enabled so the access clears the disabled-optional guard and reaches
      // the no-data-fields check.
      enable(storage, id, AccessTag);

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

  it("writes a getter value that despawns an earlier sibling to the moved row", () => {
    const world = createWorld();
    const storage = register(world, archetype([Position]));
    const sibling = spawn(storage);
    const id = spawn(storage);
    const values = despawnOnRead(storage, sibling, "x", 42);

    set(storage, id, Position, values);

    expect(get(storage, id, Position.x)).toBe(42);
  });

  it("errors on a stale entity ID #checked", () => {
    const world = createWorld();
    const Arch = archetype([Health]);
    const storage = register(world, Arch);
    const id = spawn(storage);
    despawn(storage, id);

    expect(() => {
      set(storage, id, Health, { hp: 50 });
    }).toThrow("stale entity ID");
  });

  it("errors if component is not on this archetype", () => {
    const world = createWorld();
    const Arch = archetype([Position]);
    const storage = register(world, Arch);
    const id = spawn(storage);

    expect(() => {
      set(storage, id, Velocity, { vx: 1 });
    }).toThrow("not on this archetype");
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
    const id2 = spawn(storage2);

    set(storage1, id1, Position, { x: 99 });

    expect(get(storage1, id1, Position.x)).toBe(99);
    expect(get(storage2, id2, Position.x)).toBe(0);
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
    const id = spawn(storage);

    expect(get(storage, id, RefComp.handle)).toBeUndefined();
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

    expect(get(storage, id, RefComp.handle)).toBeUndefined();
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

  it("get errors on a stale entity ID #checked", () => {
    const world = createWorld();
    const storage = register(world, archetype([Health]));
    const id = spawn(storage);
    despawn(storage, id);

    expect(() => {
      get(world, id, Health.hp);
    }).toThrow("stale entity ID");
  });

  it("set errors on a stale entity ID #checked", () => {
    const world = createWorld();
    const storage = register(world, archetype([Health]));
    const id = spawn(storage);
    despawn(storage, id);

    expect(() => {
      set(world, id, Health.hp, 42);
    }).toThrow("stale entity ID");
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

  it.each([{ value: true }, { value: false }])(
    "boolean set via field descriptor round-trips $value",
    ({ value }) => {
      const name = `BoolRoundtrip${value}`;
      const Comp = components({ [name]: { flag: false } })[name];
      assert(Comp != null);

      const world = createWorld();
      const Arch = archetype([Comp]);
      const storage = register(world, Arch);
      const id = spawn(storage);

      set(storage, id, Comp.flag, value);

      expect(get(storage, id, Comp.flag)).toBe(value);
    },
  );
});

describe("get/set on a disabled optional component", () => {
  // The disabled-optional guard is DEBUG-gated: under NDEBUG the access
  // reads/writes the pre-populated slot silently instead of throwing.
  const { AccessShield: Shield } = components({
    AccessShield: { hp: 50, defense: 10 },
  });

  function createShieldStorage() {
    const world = createWorld();
    const storage = register(world, archetype([Position], [Shield]));
    return { world, storage };
  }

  it("get errors for a disabled optional component #checked", () => {
    const { storage } = createShieldStorage();
    const id = spawn(storage);

    expect(() => {
      get(storage, id, Shield.hp);
    }).toThrow("component AccessShield not enabled on entity");
  });

  it("set errors for a disabled optional component (field-descriptor form) #checked", () => {
    const { storage } = createShieldStorage();
    const id = spawn(storage);

    expect(() => {
      set(storage, id, Shield.hp, 5);
    }).toThrow("component AccessShield not enabled on entity");
  });

  it("set errors for a disabled optional component (component+values form) #checked", () => {
    const { storage } = createShieldStorage();
    const id = spawn(storage);

    expect(() => {
      set(storage, id, Shield, { hp: 5 });
    }).toThrow("component AccessShield not enabled on entity");
  });

  it("get on an enabled optional component returns the override", () => {
    const { storage } = createShieldStorage();
    const id = spawn(storage);
    enable(storage, id, Shield, { hp: 33, defense: 4 });

    expect(get(storage, id, Shield.hp)).toBe(33);
  });

  it("set on an enabled optional component writes the field", () => {
    const { storage } = createShieldStorage();
    const id = spawn(storage);
    enable(storage, id, Shield);

    set(storage, id, Shield.hp, 42);

    expect(get(storage, id, Shield.hp)).toBe(42);
  });

  it("leaves required-component access unaffected", () => {
    const { storage } = createShieldStorage();
    const id = spawn(storage);

    set(storage, id, Position.x, 9);

    expect(get(storage, id, Position.x)).toBe(9);
  });
});

describe("set relation target field guard", () => {
  const AccessSimple = component("AccessGuardSimple", { v: 0 });

  it("rejects target on the single-field form", () => {
    const SetGuardField = relation("SetGuardField");
    const world = createWorld();
    const simpleStorage = register(world, archetype([AccessSimple]));
    const storage = register(world, archetype([AccessSimple, SetGuardField]));
    const targetId = spawn(simpleStorage);
    const entityId = spawn(storage, { SetGuardField: { target: targetId } });

    expect(() => {
      // @ts-expect-error cannot write relation target field — use link() instead
      set(storage, entityId, SetGuardField.target, targetId);
    }).toThrow("cannot write relation target field — use link() instead");
  });

  it("rejects target on the component-record form", () => {
    const SetGuardRecord = relation("SetGuardRecord");
    const world = createWorld();
    const simpleStorage = register(world, archetype([AccessSimple]));
    const storage = register(world, archetype([AccessSimple, SetGuardRecord]));
    const targetId = spawn(simpleStorage);
    const entityId = spawn(storage, { SetGuardRecord: { target: targetId } });

    expect(() => {
      // @ts-expect-error cannot write relation target field — use link() instead
      set(storage, entityId, SetGuardRecord, { target: targetId });
    }).toThrow("cannot write relation target field — use link() instead");
  });

  it("allows non-target fields on a data-carrying relation", () => {
    const SetDataRel = relation("SetDataRel", { weight: 0 });
    const world = createWorld();
    const simpleStorage = register(world, archetype([AccessSimple]));
    const storage = register(world, archetype([AccessSimple, SetDataRel]));
    const targetId = spawn(simpleStorage);
    const entityId = spawn(storage, { SetDataRel: { target: targetId, weight: 5 } });

    set(storage, entityId, SetDataRel.weight, 10);

    expect(get(storage, entityId, SetDataRel.weight)).toBe(10);
  });
});
