import { describe, expectTypeOf, it } from "vitest";
import { archetype, createWorld, type EntityId, each, register } from "../../src/index.js";
import { Payload, Position } from "./_fixtures.js";

describe("view — per-entity view type", () => {
  const world = createWorld();
  const storage = register(world, archetype([Position, Payload]));

  it("required data components produce mutable scalar-field objects", () => {
    each(storage, (e) => {
      expectTypeOf(e.Position).toEqualTypeOf<{ x: number; y: number }>();
      e.Position.x = 5;
      e.Position.y += 1;
    });
  });

  it("includes readonly entity id", () => {
    each(storage, (e) => {
      expectTypeOf(e.id).toEqualTypeOf<EntityId>();
      // @ts-expect-error the entity id is read-only
      e.id = 0 as EntityId;
    });
  });

  it("unwraps ref fields to T | undefined", () => {
    each(storage, (e) => {
      expectTypeOf(e.Payload.data).toEqualTypeOf<number[] | undefined>();
      e.Payload.data = undefined;
      e.Payload.data = [1, 2];
    });
  });
});

describe("wrong-arity callback locks", () => {
  const world = createWorld();
  const storage = register(world, archetype([Position]));

  it("2-param callback is rejected", () => {
    // @ts-expect-error the callback receives only the view
    each(storage, (_e, _i) => {});
  });

  it("3-param callback is rejected", () => {
    // @ts-expect-error the callback receives only the view
    each(storage, (_e, _i, _n) => {});
  });

  it("1-param view callback infers without annotation", () => {
    each(storage, (e) => {
      expectTypeOf(e.Position.x).toEqualTypeOf<number>();
    });
  });
});
