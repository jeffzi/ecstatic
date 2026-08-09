import { describe, expectTypeOf, it } from "vitest";

import { archetype, createWorld, type EntityId, register, spawn } from "../../src/index.js";
import { Health, Position } from "./_fixtures.js";

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
