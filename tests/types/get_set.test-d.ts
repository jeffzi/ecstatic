import { describe, expectTypeOf, it } from "vitest";

import type { EntityId } from "../../src/index.js";
import { archetype, createWorld, get, register, relation, set, spawn } from "../../src/index.js";
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

describe("set on relation fields", () => {
  const Rel = relation("GetSetTd_Rel", [], { weight: 0 });
  const world = createWorld();
  const simple = register(world, archetype([Position]));
  const storage = register(world, archetype([Position, Rel]));
  const targetId = spawn(simple);
  const id = spawn(storage, { GetSetTd_Rel: { target: targetId } });

  it("rejects writing the reserved target field", () => {
    // @ts-expect-error cannot write relation target field — use link() instead
    set(storage, id, Rel.target, targetId);
  });

  it("allows data fields and reading the target", () => {
    set(storage, id, Rel.weight, 5);
    expectTypeOf(get(storage, id, Rel.target)).toExtend<EntityId>();
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
