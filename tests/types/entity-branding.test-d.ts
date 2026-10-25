import { describe, expectTypeOf, it } from "vitest";

import {
  archetype,
  createWorld,
  each,
  type EntityId,
  query,
  register,
  spawn,
  spawnMany,
  type With,
} from "../../src/ecstatic/index.js";
import { Health, Position, Shield } from "./_fixtures.js";

declare const plainId: EntityId;

describe("EntityId<Arch>", () => {
  it("spawn returns an id assignable to plain EntityId", () => {
    const world = createWorld();
    const movers = register(world, archetype([Position]));

    expectTypeOf(spawn(movers)).toExtend<EntityId>();
  });

  it("still rejects raw numbers", () => {
    // @ts-expect-error a raw number is not an EntityId
    const _id: EntityId = 42;
  });

  it("satisfies With for components on the archetype", () => {
    const world = createWorld();
    const movers = register(world, archetype([Position]));
    const id = spawn(movers);

    expectTypeOf(id).toExtend<With<typeof Position>>();
    expectTypeOf(id).toExtend<With<[typeof Position]>>();
  });

  it("does not satisfy With for components absent from the archetype", () => {
    const world = createWorld();
    const movers = register(world, archetype([Position]));
    const id = spawn(movers);

    expectTypeOf(id).not.toExtend<With<typeof Health>>();
    expectTypeOf(id).not.toExtend<With<[typeof Position, typeof Health]>>();
  });

  it("satisfies With when the archetype has the constraint components plus extras", () => {
    const world = createWorld();
    const players = register(world, archetype([Position, Health]));
    const id = spawn(players);

    expectTypeOf(id).toExtend<With<typeof Position>>();
    expectTypeOf(id).toExtend<With<[typeof Position, typeof Health]>>();
  });

  it("counts optional components as present", () => {
    const world = createWorld();
    const players = register(world, archetype([Position], [Shield]));
    const id = spawn(players);

    expectTypeOf(id).toExtend<With<typeof Shield>>();
  });

  it("spawnMany returns archetype-branded ids", () => {
    const world = createWorld();
    const movers = register(world, archetype([Position]));
    const ids = spawnMany(movers, 3);

    // oxlint-disable-next-line typescript/no-non-null-assertion -- type-level test: ids[0] is always present after spawnMany(3)
    expectTypeOf(ids[0]!).toExtend<With<typeof Position>>();
  });
});

describe("With", () => {
  it("With<[]> admits every EntityId", () => {
    expectTypeOf(plainId).toExtend<With<[]>>();
  });

  it("a plain EntityId does not satisfy a non-empty constraint", () => {
    expectTypeOf(plainId).not.toExtend<With<typeof Position>>();
  });

  it("an archetype-branded id satisfies With<A | B> union form", () => {
    const world = createWorld();
    const players = register(world, archetype([Position, Health]));
    const id = spawn(players);

    expectTypeOf(id).toExtend<With<typeof Position | typeof Health>>();
  });
});

describe("view id branding", () => {
  it("each view id satisfies With for the storage's archetype", () => {
    const world = createWorld();
    const players = register(world, archetype([Position, Health]));

    each(players, (e) => {
      expectTypeOf(e.id).toExtend<With<typeof Position>>();
      expectTypeOf(e.id).toExtend<With<[typeof Position, typeof Health]>>();
      expectTypeOf(e.id).toExtend<EntityId>();
    });
  });

  it("query view id satisfies With for the all axis", () => {
    const world = createWorld();
    register(world, archetype([Position, Health]));

    query(world, { all: [Position] }, (e) => {
      expectTypeOf(e.id).toExtend<With<typeof Position>>();
      expectTypeOf(e.id).toExtend<EntityId>();
    });
  });
});
