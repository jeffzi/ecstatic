import { describe, expectTypeOf, it } from "vitest";

import type { EachFilter, QueryFilter } from "../../src/index.js";
import { archetype, createWorld, each, register } from "../../src/index.js";
import { OnFire, Position, Shield, Stunned } from "./_fixtures.js";

describe("each filter typing", () => {
  const world = createWorld();
  const storage = register(world, archetype([Position, OnFire], [Shield, Stunned]));

  it("promotes all-filter data optionals to their fields record", () => {
    each(storage, { all: [Shield] }, (e) => {
      expectTypeOf(e.Shield).toEqualTypeOf<{ hp: number }>();
      e.Shield.hp = 1;
    });
    each(storage, [Shield], (e) => {
      expectTypeOf(e.Shield).toEqualTypeOf<{ hp: number }>();
    });
  });

  it("promotes all-filter tag optionals to literal true", () => {
    each(storage, { all: [Stunned] }, (e) => {
      expectTypeOf(e.Stunned).toEqualTypeOf<true>();
    });
  });

  it("removes none-filter components from the view", () => {
    each(storage, { none: [Stunned] }, (e) => {
      // @ts-expect-error Stunned is removed from the view by the none filter
      void e.Stunned;
    });
  });

  it("keeps any-filter components optional", () => {
    each(storage, { any: [Shield, Stunned] }, (e) => {
      expectTypeOf(e.Shield).toEqualTypeOf<{ hp: number } | undefined>();
      expectTypeOf(e.Stunned).toEqualTypeOf<true | undefined>();
    });
  });

  it("keeps promotion of an already-required component a no-op", () => {
    each(storage, { all: [Position] }, (e) => {
      expectTypeOf(e.Position).toEqualTypeOf<{ x: number; y: number }>();
    });
  });

  it("rejects a bare component in filter position and the empty tuple", () => {
    // @ts-expect-error a bare component is not a filter — wrap it in an array
    each(storage, Shield, (e: never) => void e);
    // @ts-expect-error the empty tuple is not a valid filter
    each(storage, [], (e: never) => void e);
  });

  it("distributes promotion and removal over a multi-storage union", () => {
    const other = register(world, archetype([Position], [Shield]));
    each([storage, other], { all: [Shield] }, (e) => {
      expectTypeOf(e.Shield).toEqualTypeOf<{ hp: number }>();
      expectTypeOf(e.Position).toEqualTypeOf<{ x: number; y: number }>();
    });
    each([storage, other], { none: [Shield] }, (e) => {
      // @ts-expect-error Shield is removed from every union member by the none filter
      void e.Shield;
    });
  });

  // Reachability pruning ships behind its own test block so it can be
  // dropped independently if it proves brittle — the fallback is plain
  // distribution over the union.
  describe("reachability pruning", () => {
    it("drops union members whose archetype cannot match an all-axis component", () => {
      const withStunned = register(world, archetype([Position], [Stunned]));
      // Shield exists only on `storage`: the withStunned member is pruned, so
      // Shield promotes cleanly instead of erroring on the unmatchable member.
      each([storage, withStunned], { all: [Shield] }, (e) => {
        expectTypeOf(e.Shield).toEqualTypeOf<{ hp: number }>();
      });
    });

    it("drops union members with a none-axis component that is required", () => {
      const fireproof = register(world, archetype([Position]));
      // OnFire is required on `storage`, so a {none: [OnFire]} filter can
      // never match it — only the fireproof member's view survives.
      each([storage, fireproof], { none: [OnFire] }, (e) => {
        expectTypeOf(e.Position).toEqualTypeOf<{ x: number; y: number }>();
        // @ts-expect-error the storage member (with Shield) was pruned away
        void e.Shield;
      });
    });
  });

  it("exports EachFilter and QueryFilter with the all-axis asymmetry", () => {
    const f: EachFilter = { any: [Shield], none: [Stunned] };
    void f;
    const q: QueryFilter = { all: [Shield] };
    void q;
    // @ts-expect-error QueryFilter requires a non-empty all axis
    const missingAll: QueryFilter = { any: [Shield] };
    void missingAll;
    // @ts-expect-error QueryFilter rejects an empty all axis
    const emptyAll: QueryFilter = { all: [] };
    void emptyAll;
  });
});
