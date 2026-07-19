import { describe, it } from "vitest";
import { archetype, createWorld, despawnMany, register, spawnMany } from "../../src/index.js";
import { Position, Velocity } from "./_fixtures.js";

describe("despawnMany world-scoped overloads", () => {
  it("accepts World with no IDs", () => {
    const world = createWorld();
    register(world, archetype([Position, Velocity]));

    despawnMany(world);
  });

  it("accepts World with EntityId[] IDs", () => {
    const world = createWorld();
    const storage = register(world, archetype([Position, Velocity]));
    const ids = spawnMany(storage, 3);

    despawnMany(world, ids);
  });
});
