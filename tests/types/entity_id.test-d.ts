import { describe, expectTypeOf, it } from "vitest";
import {
  alive,
  archetype,
  createWorld,
  despawn,
  type EntityId,
  register,
  spawn,
} from "../../src/index.js";
import { Health, Position } from "./_fixtures.js";

describe("EntityId", () => {
  it("spawn returns the branded EntityId", () => {
    const world = createWorld();
    const players = register(world, archetype([Position, Health]));

    expectTypeOf(spawn(players)).toEqualTypeOf<EntityId>();
  });

  it("rejects raw numbers where an EntityId is required", () => {
    const world = createWorld();
    const players = register(world, archetype([Position]));

    // @ts-expect-error a raw number is not an EntityId
    despawn(players, 123);
    // @ts-expect-error a raw number is not an EntityId
    const _id: EntityId = 42;
  });

  it("works with despawn and alive for any EntityId", () => {
    const world = createWorld();
    const players = register(world, archetype([Position, Health]));
    const bullets = register(world, archetype([Position]));

    const playerId = spawn(players);
    const bulletId = spawn(bullets);

    despawn(players, playerId);
    alive(bullets, bulletId);
  });

  it("spawn from two worlds with the same archetype yields the same static type", () => {
    const world1 = createWorld();
    const world2 = createWorld();
    const movers1 = register(world1, archetype([Position]));
    const movers2 = register(world2, archetype([Position]));

    const id1 = spawn(movers1);
    const id2 = spawn(movers2);

    // Cross-world misuse is a runtime check; the static type is the same.
    expectTypeOf(id1).toEqualTypeOf<EntityId>();
    expectTypeOf(id2).toEqualTypeOf<EntityId>();
  });
});
