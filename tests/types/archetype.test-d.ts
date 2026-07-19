import { describe, expectTypeOf, it } from "vitest";

import {
  type ArchetypeDescriptor,
  archetype,
  createWorld,
  register,
  spawn,
} from "../../src/index.js";
import { Health, Position, Velocity } from "./_fixtures.js";

describe("archetype", () => {
  it("captures the component tuple", () => {
    const arch = archetype([Position, Velocity]);

    expectTypeOf(arch).toEqualTypeOf<
      ArchetypeDescriptor<readonly [typeof Position, typeof Velocity]>
    >();
  });

  it("does not carry SoA aliases or entity count", () => {
    const arch = archetype([Position]);

    // @ts-expect-error entity count lives on the storage, not the archetype
    arch.n;
    // @ts-expect-error SoA aliases live on the storage, not the archetype
    arch.Position;
  });
});

describe("register", () => {
  it("returns a storage typed to the archetype", () => {
    const world = createWorld();
    const storage = register(world, archetype([Position, Health]));

    expectTypeOf(storage.n).toEqualTypeOf<number>();
    expectTypeOf(storage.archetype.components).toEqualTypeOf<
      readonly [typeof Position, typeof Health]
    >();
  });
});

describe("spread component set in archetype", () => {
  it("spread const array in archetype tuple flows through to consumers", () => {
    const Transform = [Position, Velocity] as const;
    const world = createWorld();
    const storage = register(world, archetype([...Transform, Health]));

    // All three components are spawnable override keys
    spawn(storage, { Position: { x: 1 }, Velocity: { vx: 2 }, Health: { hp: 3 } });
    expectTypeOf(storage.archetype.components).toEqualTypeOf<
      readonly [typeof Position, typeof Velocity, typeof Health]
    >();
  });
});
