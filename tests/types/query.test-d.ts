import { describe, expectTypeOf, it } from "vitest";

import { createWorld, type EntityId, query } from "../../src/index.js";
import { Position, Shield, Stunned } from "./_fixtures.js";

describe("query typing", () => {
  const world = createWorld();

  it("types the comps-array view with required slots and a plain EntityId", () => {
    query(world, [Position, Stunned], (e) => {
      expectTypeOf(e.Position).toEqualTypeOf<{ x: number; y: number }>();
      expectTypeOf(e.Stunned).toEqualTypeOf<true>();
      expectTypeOf(e.id).toExtend<EntityId>();
    });
  });

  it("types any components as optional with truthiness narrowing", () => {
    query(world, { all: [Position], any: [Shield, Stunned] }, (e) => {
      expectTypeOf(e.Shield).toEqualTypeOf<{ hp: number } | undefined>();
      expectTypeOf(e.Stunned).toEqualTypeOf<true | undefined>();
      // oxlint-disable-next-line typescript/strict-boolean-expressions -- the test pins truthiness narrowing
      if (e.Shield) {
        e.Shield.hp = 1;
      }
    });
  });

  it("keeps none components out of the view", () => {
    query(world, { all: [Position], none: [Stunned] }, (e) => {
      // @ts-expect-error Stunned is excluded by the none filter
      void e.Stunned;
    });
  });

  it("requires a non-empty all axis at compile time", () => {
    // @ts-expect-error query requires an all axis
    query(world, { any: [Shield] }, () => {});
    // @ts-expect-error the all axis must be non-empty
    query(world, { all: [] }, () => {});
    // @ts-expect-error the comps array must be non-empty
    query(world, [], () => {});
  });
});
