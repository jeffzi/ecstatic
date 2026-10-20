import { describe, expectTypeOf, it } from "vitest";

import type { ComponentDescriptor } from "../../src/archetype.js";
import {
  Archetype,
  type ComponentsOf,
  createWorld,
  each,
  type EntityId,
  type OptionalsOf,
  register,
  spawn,
  type Storage,
  type With,
} from "../../src/index.js";
import { Health, Position, Shield, Stunned, Velocity } from "./_fixtures.js";

class Ship extends Archetype([Position, Health], [Shield, Stunned]) {}

describe("Archetype class declaration", () => {
  it("rejects instantiation", () => {
    // @ts-expect-error archetype classes are declarations, never instances
    const _ship = new Ship();
  });
});

describe("register with an archetype class", () => {
  const world = createWorld();
  const ships = register(world, Ship);

  it("infers the named instance type", () => {
    expectTypeOf(ships).toEqualTypeOf<Storage<Ship>>();
  });

  it("brands spawned ids with the declared components", () => {
    expectTypeOf(spawn(ships)).toExtend<With<[typeof Position, typeof Health]>>();
  });

  it("types view slots from the declared components", () => {
    each(ships, (e) => {
      expectTypeOf(e.Position).toEqualTypeOf<{ x: number; y: number }>();
      expectTypeOf(e.Shield).toEqualTypeOf<{ hp: number } | undefined>();
      expectTypeOf(e.Stunned).toEqualTypeOf<true | undefined>();
    });
  });

  it("rejects a class that is not an archetype declaration", () => {
    class Foo {
      readonly notAnArchetype = true;
    }

    // @ts-expect-error Foo does not declare an archetype
    register(world, Foo);
  });
});

describe("spawn overrides through a class-registered storage", () => {
  const world = createWorld();
  const ships = register(world, Ship);

  it("accepts partial field records and optional tag booleans", () => {
    spawn(ships, { Position: { x: 1 }, Shield: { hp: 5 }, Stunned: true });
    spawn(ships, { Health: true, Stunned: false });
  });

  it("rejects unknown fields", () => {
    // @ts-expect-error "z" is not a field of Position
    spawn(ships, { Position: { z: 1 } });
  });

  it("rejects unknown component names", () => {
    // @ts-expect-error Velocity is not on this archetype
    spawn(ships, { Velocity: { vx: 1 } });
  });
});

describe("generic helper constrained on Storage", () => {
  function trackedIds<S extends Storage>(
    storage: S,
    ids: readonly EntityId<S["archetype"]>[],
  ): EntityId<S["archetype"]>[] {
    return ids.slice(0, storage.n);
  }

  it("narrows entity ids to the storage's archetype", () => {
    const world = createWorld();
    const ships = register(world, Ship);

    expectTypeOf(trackedIds(ships, [spawn(ships)])).toEqualTypeOf<EntityId<Ship>[]>();
  });
});

describe("component-tuple type helpers on an archetype class", () => {
  it("extracts the required component tuple", () => {
    expectTypeOf<ComponentsOf<Ship>>().toEqualTypeOf<readonly [typeof Position, typeof Health]>();
  });

  it("extracts the optional component tuple", () => {
    expectTypeOf<OptionalsOf<Ship>>().toEqualTypeOf<readonly [typeof Shield, typeof Stunned]>();
  });
});

describe("component-list statics on an archetype class", () => {
  it("types the required component tuple", () => {
    expectTypeOf(Ship.components).toEqualTypeOf<readonly [typeof Position, typeof Health]>();
  });

  it("types the optional component tuple", () => {
    expectTypeOf(Ship.optionals).toEqualTypeOf<readonly [typeof Shield, typeof Stunned]>();
  });

  it("types read-only lists when built from mutable array variables", () => {
    const required: ComponentDescriptor[] = [Position];
    const optionals: ComponentDescriptor[] = [Shield];

    class Hull extends Archetype(required, optionals) {}

    expectTypeOf(Hull.components).toEqualTypeOf<readonly ComponentDescriptor[]>();
    expectTypeOf(Hull.optionals).toEqualTypeOf<readonly ComponentDescriptor[]>();
  });
});

describe("archetype class composed from another class's statics", () => {
  class Tank extends Archetype([...Ship.components, Velocity], [...Ship.optionals]) {}
  const world = createWorld();
  const tanks = register(world, Tank);

  it("infers the named instance type", () => {
    expectTypeOf(tanks).toEqualTypeOf<Storage<Tank>>();
  });

  it("brands spawned ids with the inherited and added components", () => {
    expectTypeOf(spawn(tanks)).toExtend<With<[typeof Position, typeof Health, typeof Velocity]>>();
  });

  it("types view slots from the composed lists", () => {
    each(tanks, (e) => {
      expectTypeOf(e.Velocity).toEqualTypeOf<{ vx: number; vy: number }>();
      expectTypeOf(e.Shield).toEqualTypeOf<{ hp: number } | undefined>();
    });
  });

  it("accepts spawn overrides for inherited and added components", () => {
    spawn(tanks, { Position: { x: 1 }, Velocity: { vx: 2 }, Stunned: true });
  });

  it("rejects unknown component names", () => {
    // @ts-expect-error OnFire is not on this archetype
    spawn(tanks, { OnFire: true });
  });
});

describe("archetype class declared from a spread component set", () => {
  const Transform = [Position, Velocity] as const;
  class Mover extends Archetype([...Transform, Health]) {}
  const world = createWorld();
  const movers = register(world, Mover);

  it("infers the named instance type", () => {
    expectTypeOf(movers).toEqualTypeOf<Storage<Mover>>();
  });

  it("types view slots from the spread set", () => {
    each(movers, (e) => {
      expectTypeOf(e.Position).toEqualTypeOf<{ x: number; y: number }>();
      expectTypeOf(e.Velocity).toEqualTypeOf<{ vx: number; vy: number }>();
    });
  });

  it("accepts spawn overrides for every component of the spread set", () => {
    spawn(movers, { Position: { x: 1 }, Velocity: { vx: 2 }, Health: { hp: 3 } });
  });

  it("rejects unknown component names", () => {
    // @ts-expect-error OnFire is not on this archetype
    spawn(movers, { OnFire: true });
  });
});
