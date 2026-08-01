import { describe, expectTypeOf, it } from "vitest";

import { archetype, createWorld, enable, has, hasAny, register, spawn } from "../../src/index.js";
import { Health, Position, Shield, Stunned } from "./_fixtures.js";

describe("has/hasAny typing", () => {
  const world = createWorld();
  const storage = register(world, archetype([Position], [Shield, Stunned]));
  const id = spawn(storage);

  it("accepts optional components in both positional and array forms", () => {
    expectTypeOf(has(storage, id, Shield)).toEqualTypeOf<boolean>();
    expectTypeOf(has(storage, id, [Shield, Stunned])).toEqualTypeOf<boolean>();
    expectTypeOf(hasAny(storage, id, [Shield, Stunned])).toEqualTypeOf<boolean>();
  });

  it("rejects required and off-archetype components with sentence errors", () => {
    // @ts-expect-error Position is required, not optional
    has(storage, id, Position);
    // @ts-expect-error Health is not on this archetype
    has(storage, id, Health);
    // @ts-expect-error Position is required, not optional
    has(storage, id, [Position]);
    // @ts-expect-error Health is not on this archetype
    hasAny(storage, id, [Health]);
  });

  it("rejects the empty tuple", () => {
    // @ts-expect-error at least one component is required
    has(storage, id, []);
    // @ts-expect-error at least one component is required
    hasAny(storage, id, []);
  });

  it("rejects a bare component in hasAny with a sentence pointing at has()", () => {
    // @ts-expect-error hasAny takes a component array — use has() for a single component
    hasAny(storage, id, Shield);
  });

  it("narrows the storage through the has() guard without breaking CheckOptional", () => {
    if (has(storage, id, Shield)) {
      // The guard intersects phantom promotion slots; the storage stays usable
      // and enable/disable still validate against the archetype's optionals.
      enable(storage, id, Shield, { hp: 1 });
      // @ts-expect-error Position stays required, not optional, inside the guard
      enable(storage, id, Position);
    }
  });

  it("stays usable as a plain boolean", () => {
    const flag: boolean = has(storage, id, Shield);
    expectTypeOf(flag).toEqualTypeOf<boolean>();
  });

  it("leaves world forms type-unvalidated", () => {
    expectTypeOf(has(world, id, Health)).toEqualTypeOf<boolean>();
    expectTypeOf(has(world, id, [Health, Position])).toEqualTypeOf<boolean>();
    expectTypeOf(hasAny(world, id, [Health])).toEqualTypeOf<boolean>();
  });
});
