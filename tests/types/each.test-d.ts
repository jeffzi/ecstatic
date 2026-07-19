import { describe, expectTypeOf, it } from "vitest";

import { archetype, createWorld, type EntityId, each, register } from "../../src/index.js";
import { Health, Position, Shield, Velocity } from "./_fixtures.js";

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

  describe("union of storages", () => {
    const posVel = register(world, archetype([Position, Velocity]));
    const posVelHealth = register(world, archetype([Position, Velocity, Health]));
    const posVelShield = register(world, archetype([Position, Velocity, Shield]));

    it("provides concrete types for common components only", () => {
      // Directly pass union to each without intermediate variable
      const testFn = (storage: typeof posVel | typeof posVelHealth | typeof posVelShield) => {
        each(storage, (e) => {
          expectTypeOf(e.Position).toEqualTypeOf<{ x: number; y: number }>();
          expectTypeOf(e.Velocity).toEqualTypeOf<{ vx: number; vy: number }>();
          expectTypeOf(e.id).toEqualTypeOf<EntityId>();
        });
      };
      testFn(posVel);
    });

    it("disallows access to non-common components in union", () => {
      const testFn = (storage: typeof posVel | typeof posVelHealth | typeof posVelShield) => {
        each(storage, (e) => {
          // @ts-expect-error Health is not on all archetypes in the union
          e.Health;
          // @ts-expect-error Shield is not on all archetypes in the union
          e.Shield;
        });
      };
      testFn(posVel);
    });
  });
});
