import { describe, expect, it } from "vitest";

import { entityIndex } from "../../src/entity-id.js";
import {
  archetype,
  components,
  createWorld,
  despawn,
  getSources,
  getTarget,
  hasSources,
  link,
  register,
  relation,
  spawn,
} from "../../src/index.js";

const { RecycleSpec_Comp } = components({ RecycleSpec_Comp: { x: 0 } });

describe("recycled slots and the reverse map", () => {
  it("an entity recycled into a dead target's index inherits none of its sources", () => {
    const Rel = relation("RecycleTarget_Rel");
    const world = createWorld();
    const simple = register(world, archetype([RecycleSpec_Comp]));
    const storage = register(world, archetype([RecycleSpec_Comp, Rel]));

    const target = spawn(simple);
    spawn(storage, { RecycleTarget_Rel: { target } });
    despawn(simple, target);

    // The freed index is recycled by the next spawn in this world
    const recycled = spawn(simple);
    expect(entityIndex(recycled)).toBe(entityIndex(target));

    expect(hasSources(world, Rel, recycled)).toBe(false);
    expect(getSources(world, Rel, recycled)).toStrictEqual([]);
  });

  it("an entity recycled into a dead source's index is not listed as a source", () => {
    const Rel = relation("RecycleSource_Rel");
    const world = createWorld();
    const simple = register(world, archetype([RecycleSpec_Comp]));
    const storage = register(world, archetype([RecycleSpec_Comp], [Rel]));

    const target = spawn(simple);
    const source = spawn(storage);
    link(world, source, Rel, target);
    despawn(storage, source);

    const recycled = spawn(storage);
    expect(entityIndex(recycled)).toBe(entityIndex(source));

    expect(getSources(world, Rel, target)).toStrictEqual([]);
    expect(getTarget(world, recycled, Rel)).toBeUndefined();
  });

  it("a recycled source can link again without ghost entries", () => {
    const Rel = relation("RecycleRelink_Rel");
    const world = createWorld();
    const simple = register(world, archetype([RecycleSpec_Comp]));
    const storage = register(world, archetype([RecycleSpec_Comp], [Rel]));

    const targetA = spawn(simple);
    const targetB = spawn(simple);
    const source = spawn(storage);
    link(world, source, Rel, targetA);
    despawn(storage, source);

    const recycled = spawn(storage);
    link(world, recycled, Rel, targetB);

    expect(getSources(world, Rel, targetA)).toStrictEqual([]);
    expect(getSources(world, Rel, targetB)).toStrictEqual([recycled]);
  });
});
