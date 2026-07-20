import { describe, expectTypeOf, it } from "vitest";

import { archetype, createWorld, get, register, set, spawn } from "../../src/index.js";
import { Position } from "./_fixtures.js";

describe("get", () => {
  const world = createWorld();
  const movers = register(world, archetype([Position]));
  const id = spawn(movers);

  it("returns the field's value type", () => {
    expectTypeOf(get(movers, id, Position.x)).toEqualTypeOf<number>();
    expectTypeOf(get(movers, id, Position.y)).toEqualTypeOf<number>();
  });

  it("rejects unknown field names", () => {
    // @ts-expect-error "wrong" is not a field of Position
    get(movers, id, Position.wrong);
  });
});

describe("set", () => {
  const world = createWorld();
  const movers = register(world, archetype([Position]));
  const id = spawn(movers);

  it("accepts a partial update", () => {
    set(movers, id, Position.x, 5);
    set(movers, id, Position, { x: 5, y: 10 });
    set(movers, id, Position, {});
  });

  it("rejects unknown field names", () => {
    // @ts-expect-error "wrong" is not a field of Position
    set(movers, id, Position, { wrong: 5 });
  });

  it("rejects wrong value types", () => {
    // @ts-expect-error string is not assignable to number
    set(movers, id, Position.x, "oops");
    // @ts-expect-error string is not assignable to number
    set(movers, id, Position, { x: "oops" });
  });
});

describe("get/set (world form)", () => {
  const world = createWorld();
  const movers = register(world, archetype([Position]));
  const id = spawn(movers);

  it("accepts a World and infers the scalar value type", () => {
    expectTypeOf(get(world, id, Position.x)).toEqualTypeOf<number>();
    set(world, id, Position.x, 5);
  });

  it("rejects wrong value type", () => {
    // @ts-expect-error string is not assignable to number
    set(world, id, Position.x, "oops");
  });
});
