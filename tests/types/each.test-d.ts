import { describe, expectTypeOf, it } from "vitest";
import { archetype, createWorld, type EntityId, each, register } from "../../src/index.js";
import { Health, Position, Velocity } from "./_fixtures.js";

describe("each", () => {
  const world = createWorld();
  const players = register(world, archetype([Position, Velocity, Health]));
  const enemies = register(world, archetype([Position, Velocity, Health]));

  it("single storage provides concrete types for components", () => {
    each(players, (e) => {
      expectTypeOf(e.Position).toEqualTypeOf<{ x: number; y: number }>();
      expectTypeOf(e.Velocity).toEqualTypeOf<{ vx: number; vy: number }>();
      expectTypeOf(e.Health).toEqualTypeOf<{ hp: number }>();
      expectTypeOf(e.id).toEqualTypeOf<EntityId>();
    });
  });

  it("disallows the component-list form", () => {
    // @ts-expect-error component lists are not accepted
    each(world, [Position, Velocity], () => {});
  });

  it("disallows the multi-storage array form", () => {
    // @ts-expect-error multi-storage iteration is not part of the surface
    each([players, enemies], () => {});
  });
});
