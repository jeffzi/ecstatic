import { describe, expect, it } from "vitest";

import {
  alive,
  archetype,
  components,
  createWorld,
  despawn,
  disable,
  disableMany,
  enable,
  enableMany,
  ref,
  register,
  relation,
  spawn,
} from "../src/index.js";
import { rowOf } from "./fixtures.js";

const { EnDisPosition: Position } = components({
  EnDisPosition: { x: 0, y: 0 },
});
const { EnDisShield: Shield } = components({
  EnDisShield: { hp: 50, defense: 10 },
});
const { EnDisStunned: Stunned } = components({ EnDisStunned: {} });
const { EnDisOnFire: OnFire } = components({ EnDisOnFire: {} });

function createStunnedStorage() {
  const world = createWorld();
  const storage = register(world, archetype([Position], [Stunned]));
  return { world, storage };
}

function createShieldStorage() {
  const world = createWorld();
  const storage = register(world, archetype([Position], [Shield]));
  return { world, storage };
}

function createStunnedOnFireStorage() {
  const world = createWorld();
  const storage = register(world, archetype([Position], [Stunned, OnFire]));
  return { world, storage };
}

describe("enable", () => {
  it("sets bit in mask for 0-field component", () => {
    const { storage } = createStunnedStorage();
    const id = spawn(storage);

    enable(storage, id, Stunned);

    const bit = storage.archetype.optionalBits.get("EnDisStunned")!;
    expect(storage.mask[rowOf(storage, id)]).toBe(bit);
  });

  it("sets bit and exposes pre-populated defaults for data-carrying component", () => {
    const { storage } = createShieldStorage();
    const id = spawn(storage);

    enable(storage, id, Shield);

    const row = rowOf(storage, id);
    const bit = storage.archetype.optionalBits.get("EnDisShield")!;
    expect(storage.mask[row]).toBe(bit);
    const soa = storage.columns.get(Shield)!;
    expect(soa.hp![row]).toBe(50);
    expect(soa.defense![row]).toBe(10);
  });

  it("writes only the listed fields on enable with values", () => {
    const { storage } = createShieldStorage();
    const id = spawn(storage);

    enable(storage, id, Shield, { hp: 75 });

    const row = rowOf(storage, id);
    const soa = storage.columns.get(Shield)!;
    expect(soa.hp![row]).toBe(75);
    expect(soa.defense![row]).toBe(10);
  });

  it("accepts record-form input for a component named __ecstatic_default_values", () => {
    const { __ecstatic_default_values: DefaultValues } = components({
      __ecstatic_default_values: { hp: 50, defense: 10 },
    });
    const world = createWorld();
    const storage = register(world, archetype([Position], [DefaultValues]));
    const id = spawn(storage);

    enable(storage, id, { __ecstatic_default_values: { hp: 75 } });

    const row = rowOf(storage, id);
    const bit = storage.archetype.optionalBits.get("__ecstatic_default_values")!;
    expect(storage.mask[row]).toBe(bit);
    const soa = storage.columns.get(DefaultValues)!;
    expect(soa.hp![row]).toBe(75);
  });

  it("stores ref-field override values by reference (no clone)", () => {
    const { EnDisAura: Aura } = components({
      EnDisAura: { effect: ref<{ charges: number }>() },
    });
    const world = createWorld();
    const storage = register(world, archetype([Position], [Aura]));
    const id = spawn(storage);
    const obj = { charges: 1 };

    enable(storage, id, Aura, { effect: obj });

    const soa = storage.columns.get(Aura)!;
    expect(soa.effect![rowOf(storage, id)]).toBe(obj);
  });

  it("is idempotent", () => {
    const { storage } = createStunnedStorage();
    const id = spawn(storage);

    enable(storage, id, Stunned);
    enable(storage, id, Stunned);

    const bit = storage.archetype.optionalBits.get("EnDisStunned")!;
    expect(storage.mask[rowOf(storage, id)]).toBe(bit);
  });

  it("errors on non-optional component", () => {
    const { storage } = createStunnedStorage();
    const id = spawn(storage);

    expect(() => {
      // @ts-expect-error Position is required, not optional — runtime validates too
      enable(storage, id, Position);
    }).toThrow("component EnDisPosition is not optional on this archetype");
  });
});

describe("disable", () => {
  it("clears bit in mask", () => {
    const { storage } = createStunnedStorage();
    const id = spawn(storage);

    enable(storage, id, Stunned);
    disable(storage, id, Stunned);

    expect(storage.mask[rowOf(storage, id)]).toBe(0);
  });

  it("preserves stale SoA data after disable (pure bit flip)", () => {
    const { storage } = createShieldStorage();
    const id = spawn(storage);
    enable(storage, id, Shield, { hp: 75 });

    disable(storage, id, Shield);

    const row = rowOf(storage, id);
    expect(storage.mask[row]).toBe(0);
    const soa = storage.columns.get(Shield)!;
    expect(soa.hp![row]).toBe(75);
    expect(soa.defense![row]).toBe(10);
  });

  it("resumes the disabled value on re-enable with no values", () => {
    const { storage } = createShieldStorage();
    const id = spawn(storage);
    enable(storage, id, Shield, { hp: 75 });
    disable(storage, id, Shield);

    enable(storage, id, Shield);

    const row = rowOf(storage, id);
    const soa = storage.columns.get(Shield)!;
    expect(soa.hp![row]).toBe(75);
    expect(soa.defense![row]).toBe(10);
  });

  it("merges overrides with retained values on re-enable with partial values", () => {
    const { storage } = createShieldStorage();
    const id = spawn(storage);
    enable(storage, id, Shield, { hp: 75, defense: 5 });
    disable(storage, id, Shield);

    enable(storage, id, Shield, { hp: 99 });

    const row = rowOf(storage, id);
    const soa = storage.columns.get(Shield)!;
    expect(soa.hp![row]).toBe(99);
    expect(soa.defense![row]).toBe(5);
  });

  it("is idempotent", () => {
    const { storage } = createStunnedStorage();
    const id = spawn(storage);

    disable(storage, id, Stunned);
    disable(storage, id, Stunned);

    expect(storage.mask[rowOf(storage, id)]).toBe(0);
    expect(alive(storage, id)).toBe(true);
  });

  it("errors on non-optional component", () => {
    const { storage } = createStunnedStorage();
    const id = spawn(storage);

    expect(() => {
      // @ts-expect-error Position is required, not optional — runtime validates too
      disable(storage, id, Position);
    }).toThrow("component EnDisPosition is not optional on this archetype");
  });
});

describe("disable array form", () => {
  it("clears all listed bits in one combined mask write", () => {
    const { storage } = createStunnedOnFireStorage();
    const id = spawn(storage);
    enable(storage, id, Stunned);
    enable(storage, id, OnFire);

    disable(storage, id, [Stunned, OnFire]);

    expect(storage.mask[rowOf(storage, id)]).toBe(0);
  });

  it("leaves unlisted bits intact", () => {
    const { storage } = createStunnedOnFireStorage();
    const id = spawn(storage);
    enable(storage, id, Stunned);
    enable(storage, id, OnFire);

    disable(storage, id, [OnFire]);

    const stunnedBit = storage.archetype.optionalBits.get("EnDisStunned")!;
    expect(storage.mask[rowOf(storage, id)]).toBe(stunnedBit);
  });

  it("pre-validates every element before mutating", () => {
    const { storage } = createStunnedOnFireStorage();
    const id = spawn(storage);
    enable(storage, id, Stunned);

    expect(() => {
      // @ts-expect-error Position is required, not optional — runtime validates too
      disable(storage, id, [Stunned, Position]);
    }).toThrow("component EnDisPosition is not optional on this archetype");

    const stunnedBit = storage.archetype.optionalBits.get("EnDisStunned")!;
    expect(storage.mask[rowOf(storage, id)]).toBe(stunnedBit);
  });

  it("errors on an empty component array", () => {
    const { storage } = createStunnedStorage();
    const id = spawn(storage);

    expect(() => {
      // @ts-expect-error the empty tuple is rejected at the type level too
      disable(storage, id, []);
    }).toThrow("disable requires at least one component");
  });
});

describe("enable record boolean values", () => {
  it("true enables a tag with no field writes", () => {
    const { storage } = createStunnedStorage();
    const id = spawn(storage);

    enable(storage, id, { EnDisStunned: true });

    const bit = storage.archetype.optionalBits.get("EnDisStunned")!;
    expect(storage.mask[rowOf(storage, id)]).toBe(bit);
  });

  it("true enables a data component with resume semantics", () => {
    const { storage } = createShieldStorage();
    const id = spawn(storage);
    enable(storage, id, Shield, { hp: 75 });
    disable(storage, id, Shield);

    enable(storage, id, { EnDisShield: true });

    const row = rowOf(storage, id);
    const bit = storage.archetype.optionalBits.get("EnDisShield")!;
    expect(storage.mask[row]).toBe(bit);
    expect(storage.columns.get(Shield)!.hp![row]).toBe(75);
  });

  it("mixed record: true enables, false skips, object patches", () => {
    const world = createWorld();
    const storage = register(world, archetype([Position], [Shield, Stunned, OnFire]));
    const id = spawn(storage);

    enable(storage, id, { EnDisShield: { hp: 75 }, EnDisStunned: true, EnDisOnFire: false });

    const row = rowOf(storage, id);
    const shieldBit = storage.archetype.optionalBits.get("EnDisShield")!;
    const stunnedBit = storage.archetype.optionalBits.get("EnDisStunned")!;
    expect(storage.mask[row]).toBe(shieldBit | stunnedBit);
    expect(storage.columns.get(Shield)!.hp![row]).toBe(75);
  });

  it("all-false record is a no-op", () => {
    const { storage } = createStunnedStorage();
    const id = spawn(storage);

    enable(storage, id, { EnDisStunned: false });

    expect(storage.mask[rowOf(storage, id)]).toBe(0);
  });

  it("errors on an unknown component name", () => {
    const { storage } = createStunnedStorage();
    const id = spawn(storage);

    expect(() => {
      // @ts-expect-error Nope is not on this archetype — runtime validates too
      enable(storage, id, { Nope: true });
    }).toThrow("unknown component name: Nope");
  });

  it("errors on an unknown component name with earlier entries unapplied", () => {
    const { storage } = createShieldStorage();
    const id = spawn(storage);

    expect(() => {
      // @ts-expect-error Nope is not on this archetype — runtime validates too
      enable(storage, id, { EnDisShield: { hp: 75 }, Nope: true });
    }).toThrow("unknown component name: Nope");

    const row = rowOf(storage, id);
    expect(storage.mask[row]).toBe(0);
    expect(storage.columns.get(Shield)!.hp![row]).toBe(50);
  });

  it("errors on a non-optional component with earlier entries unapplied", () => {
    const { storage } = createShieldStorage();
    const id = spawn(storage);

    expect(() => {
      // @ts-expect-error EnDisPosition is required, not optional — runtime validates too
      enable(storage, id, { EnDisShield: { hp: 75 }, EnDisPosition: true });
    }).toThrow("component EnDisPosition is not optional on this archetype");

    const row = rowOf(storage, id);
    expect(storage.mask[row]).toBe(0);
    expect(storage.columns.get(Shield)!.hp![row]).toBe(50);
  });
});

describe("world forms", () => {
  it("enable dispatches by id to the owning storage", () => {
    const { world, storage } = createShieldStorage();
    const id = spawn(storage);

    enable(world, id, Shield, { hp: 75 });

    const row = rowOf(storage, id);
    const bit = storage.archetype.optionalBits.get("EnDisShield")!;
    expect(storage.mask[row]).toBe(bit);
    expect(storage.columns.get(Shield)!.hp![row]).toBe(75);
  });

  it("disable dispatches by id to the owning storage", () => {
    const { world, storage } = createStunnedStorage();
    const id = spawn(storage);
    enable(storage, id, Stunned);

    disable(world, id, Stunned);

    expect(storage.mask[rowOf(storage, id)]).toBe(0);
  });

  it("throws on a stale ID", () => {
    const { world, storage } = createStunnedStorage();
    const id = spawn(storage);
    despawn(storage, id);

    expect(() => {
      enable(world, id, Stunned);
    }).toThrow("stale entity ID");
    expect(() => {
      disable(world, id, Stunned);
    }).toThrow("stale entity ID");
  });

  it("throws on a stale ID through the storage form", () => {
    const { storage } = createStunnedStorage();
    const id = spawn(storage);
    despawn(storage, id);

    expect(() => {
      enable(storage, id, Stunned);
    }).toThrow("stale entity ID");
  });
});

describe("enable/disable reject relations (dynamic path)", () => {
  function createGuardContext<N extends string>(relName: N) {
    const Rel = relation(relName);
    const world = createWorld();
    const storage = register(world, archetype([Position], [Rel]));
    const id = spawn(storage);
    return { Rel, storage, id };
  }

  it("enable errors on relation component", () => {
    const { Rel, storage, id } = createGuardContext("EnableRelGuard_Rel");
    expect(() => {
      // @ts-expect-error relations are toggled via link()/unlink()
      enable(storage, id, Rel);
    }).toThrow("EnableRelGuard_Rel is a relation — use link() instead");
  });

  it("disable errors on relation component", () => {
    const { Rel, storage, id } = createGuardContext("DisableRelGuard_Rel");
    expect(() => {
      // @ts-expect-error relations are toggled via link()/unlink()
      disable(storage, id, Rel);
    }).toThrow("DisableRelGuard_Rel is a relation — use unlink() instead");
  });

  it("enableMany errors on relation component", () => {
    const { storage, id } = createGuardContext("EnableManyRelGuard_Rel");
    expect(() => {
      // @ts-expect-error relations are toggled via link()/unlink()
      enableMany(storage, [id], { EnableManyRelGuard_Rel: {} });
    }).toThrow("EnableManyRelGuard_Rel is a relation — use link() instead");
  });

  it("disableMany errors on relation component", () => {
    const { Rel, storage } = createGuardContext("DisableManyRelGuard_Rel");
    expect(() => {
      // @ts-expect-error relations are toggled via link()/unlink()
      disableMany(storage, [Rel]);
    }).toThrow("DisableManyRelGuard_Rel is a relation — use unlink() instead");
  });
});
