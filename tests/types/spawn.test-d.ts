import { describe, expectTypeOf, it } from "vitest";

import type { SpawnOverrides, SpawnOverridesFor } from "../../src/entity/spawn.js";
import {
  Archetype,
  type ArchetypeDescriptor,
  archetype,
  createWorld,
  type EntityId,
  register,
  relation,
  spawn,
} from "../../src/index.js";
import { Health, Position, Stunned } from "./_fixtures.js";

describe("spawn", () => {
  const world = createWorld();
  const storage = register(world, archetype([Position, Health]));

  it("returns the branded EntityId", () => {
    expectTypeOf(spawn(storage)).toExtend<EntityId>();
  });

  it("returns the exact branded EntityId for the archetype", () => {
    expectTypeOf(spawn(storage)).toEqualTypeOf<
      EntityId<typeof storage extends { readonly archetype: infer A } ? A : never>
    >();
  });

  it("accepts partial component overrides", () => {
    spawn(storage, { Position: { x: 100 } });
    spawn(storage, { Health: { hp: 50 } });
    spawn(storage, { Position: { x: 1, y: 2 }, Health: { hp: 3 } });
    spawn(storage, {});
  });

  it("rejects unknown components", () => {
    // @ts-expect-error Velocity is not on this archetype
    spawn(storage, { Velocity: { vx: 1 } });
  });

  it("rejects unknown fields within components", () => {
    // @ts-expect-error "wrong" is not a field of Position
    spawn(storage, { Position: { wrong: 1 } });
  });

  it("rejects wrong value types", () => {
    // @ts-expect-error string is not assignable to number
    spawn(storage, { Position: { x: "oops" } });
  });

  it("accepts true for required components to use defaults", () => {
    spawn(storage, { Position: true });
  });

  it("rejects false for required components", () => {
    // @ts-expect-error required components cannot be disabled at spawn
    spawn(storage, { Position: false });
  });
});

describe("SpawnOverridesFor", () => {
  const Guarding = relation("SpawnOverridesForType_Guarding", [Position]);

  class Enemy extends Archetype([Position, Health], [Stunned]) {}
  class Guard extends Archetype([Health, Guarding]) {}

  it("resolves a relation-free archetype to a single flat object type", () => {
    expectTypeOf<SpawnOverridesFor<Enemy>>().toEqualTypeOf<{
      Position?: true | Partial<{ x: number; y: number }>;
      Health?: true | Partial<{ hp: number }>;
      Stunned?: boolean;
    }>();
  });

  it("keeps a required relation key mandatory", () => {
    expectTypeOf<Record<string, never>>().not.toExtend<SpawnOverridesFor<Guard>>();
  });

  it("falls back to the loose record for an untyped descriptor", () => {
    expectTypeOf<SpawnOverridesFor<ArchetypeDescriptor>>().toEqualTypeOf<SpawnOverrides>();
  });
});
