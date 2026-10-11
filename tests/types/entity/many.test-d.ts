import { describe, expectTypeOf, it } from "vitest";

import {
  archetype,
  createWorld,
  despawnMany,
  type EntityId,
  register,
  spawnMany,
} from "../../../src/index.js";
import { Position, Velocity } from "../_fixtures.js";

describe("spawnMany", () => {
  const world = createWorld();
  const storage = register(world, archetype([Position, Velocity]));

  it("returns EntityId[]", () => {
    expectTypeOf(spawnMany(storage, 5)).toExtend<EntityId[]>();
  });

  it("accepts component overrides with appropriate types", () => {
    spawnMany(storage, 3, { Position: { x: 10 } });
    spawnMany(storage, 3, { Position: true, Velocity: { vx: 1 } });

    // @ts-expect-error "wrong" is not a field of Position
    spawnMany(storage, 3, { Position: { wrong: 1 } });
  });

  it("accepts the 3-arg out form", () => {
    const out: EntityId[] = [];

    expectTypeOf(spawnMany(storage, 3, out)).toExtend<EntityId[]>();
  });

  it("resolves an EntityId[] argument to the out form, not overrides", () => {
    const buf = spawnMany(storage, 2);

    spawnMany(storage, 2, buf);
  });

  it("accepts the 4-arg overrides + out form", () => {
    const out: EntityId[] = [];

    spawnMany(storage, 2, { Position: { x: 9 } }, out);
    // Explicit undefined overrides are accepted (the runtime disambiguates)
    spawnMany(storage, 2, undefined, out);
  });
});

describe("despawnMany", () => {
  const world = createWorld();
  const storage = register(world, archetype([Position, Velocity]));

  it("ids parameter is optional", () => {
    const ids = spawnMany(storage, 3);

    despawnMany(storage);
    despawnMany(storage, ids);
  });
});
