import { describe, expectTypeOf, it } from "vitest";

import { archetype, createWorld, each, register } from "../../src/index.js";
import { OnFire, Position, Shield, Stunned } from "./_fixtures.js";

describe("view optionals typing", () => {
  const world = createWorld();
  const storage = register(world, archetype([Position, OnFire], [Shield, Stunned]));

  it("types an optional data component as its fields record or undefined", () => {
    each(storage, (e) => {
      expectTypeOf(e.Shield).toEqualTypeOf<{ hp: number } | undefined>();
    });
  });

  it("narrows an optional data component through truthiness", () => {
    each(storage, (e) => {
      if (e.Shield) {
        e.Shield.hp = 1;
        expectTypeOf(e.Shield.hp).toEqualTypeOf<number>();
      }
      // @ts-expect-error Shield may be undefined outside the truthiness branch
      e.Shield.hp = 1;
    });
  });

  it("types an optional tag as true | undefined", () => {
    each(storage, (e) => {
      expectTypeOf(e.Stunned).toEqualTypeOf<true | undefined>();
    });
  });

  it("types a required tag as literal true", () => {
    each(storage, (e) => {
      expectTypeOf(e.OnFire).toEqualTypeOf<true>();
    });
  });
});
