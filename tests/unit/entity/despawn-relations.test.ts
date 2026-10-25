import { describe, expect, it } from "vitest";

import {
  archetype,
  components,
  countSources,
  createWorld,
  despawn,
  despawnMany,
  getSources,
  getTarget,
  hasSources,
  link,
  querySources,
  register,
  relation,
  spawn,
  unlink,
} from "../../../src/ecstatic/index.js";

const { DRSpec_Comp, DRSpec_Comp2 } = components({
  DRSpec_Comp: { x: 0 },
  DRSpec_Comp2: { y: 0 },
});

describe("despawn reverse-map cleanup", () => {
  it("source despawn removes its entry from the target's reverse map", () => {
    const Rel = relation("DespawnRevClean_Link");
    const world = createWorld();
    const simple = register(world, archetype([DRSpec_Comp]));
    const storage = register(world, archetype([DRSpec_Comp, Rel]));

    const target = spawn(simple);
    const source1 = spawn(storage, { DespawnRevClean_Link: { target } });
    const source2 = spawn(storage, { DespawnRevClean_Link: { target } });

    expect(getSources(world, Rel, target).length).toBe(2);

    despawn(storage, source1);

    expect(getSources(world, Rel, target)).toStrictEqual([source2]);
  });

  it("target despawn clears all its reverse-map entries", () => {
    const Rel = relation("DespawnRevClean_Target");
    const world = createWorld();
    const simple = register(world, archetype([DRSpec_Comp]));
    const storage = register(world, archetype([DRSpec_Comp, Rel]));

    const target = spawn(simple);
    spawn(storage, { DespawnRevClean_Target: { target } });
    spawn(storage, { DespawnRevClean_Target: { target } });

    expect(getSources(world, Rel, target).length).toBe(2);

    despawn(simple, target);

    expect(getSources(world, Rel, target)).toStrictEqual([]);
  });

  it("source despawn after unlink leaves no reverse-map entry", () => {
    const Rel = relation("OptRelDisable_Rel");
    const world = createWorld();
    const storage = register(world, archetype([DRSpec_Comp], [Rel]));

    const target = spawn(storage);
    const source = spawn(storage);

    link(world, source, Rel, target);
    expect(hasSources(world, Rel, target)).toBe(true);

    unlink(world, source, Rel);
    despawn(storage, source);

    expect(hasSources(world, Rel, target)).toBe(false);
  });

  it("hasSources returns false after despawning the only source", () => {
    const Rel = relation("HasSourcesDespawnSrc_Rel");
    const world = createWorld();
    const simple = register(world, archetype([DRSpec_Comp]));
    const storage = register(world, archetype([DRSpec_Comp, Rel]));

    const target = spawn(simple);
    const source = spawn(storage, { HasSourcesDespawnSrc_Rel: { target } });

    expect(hasSources(world, Rel, target)).toBe(true);
    despawn(storage, source);
    expect(hasSources(world, Rel, target)).toBe(false);
  });

  it("countSources decrements after despawning a source", () => {
    const Rel = relation("CountSourcesDespawn_Rel");
    const world = createWorld();
    const simple = register(world, archetype([DRSpec_Comp]));
    const storage = register(world, archetype([DRSpec_Comp, Rel]));

    const target = spawn(simple);
    const source1 = spawn(storage, { CountSourcesDespawn_Rel: { target } });
    spawn(storage, { CountSourcesDespawn_Rel: { target } });

    expect(countSources(world, Rel, target)).toBe(2);
    despawn(storage, source1);
    expect(countSources(world, Rel, target)).toBe(1);
  });

  it("world-form despawn also cleans the reverse map", () => {
    const Rel = relation("DespawnWorldForm_Rel");
    const world = createWorld();
    const simple = register(world, archetype([DRSpec_Comp]));
    const storage = register(world, archetype([DRSpec_Comp, Rel]));

    const target = spawn(simple);
    const source = spawn(storage, { DespawnWorldForm_Rel: { target } });

    despawn(world, source);

    expect(hasSources(world, Rel, target)).toBe(false);
  });
});

describe("despawnMany reverse-map cleanup", () => {
  it("no-ids form removes all sources from the reverse map", () => {
    const Rel = relation("DMRevClean_Rel");
    const world = createWorld();
    const targetStorage = register(world, archetype([DRSpec_Comp2]));
    const sourceStorage = register(world, archetype([DRSpec_Comp, Rel]));

    const target = spawn(targetStorage);
    spawn(sourceStorage, { DMRevClean_Rel: { target } });
    spawn(sourceStorage, { DMRevClean_Rel: { target } });

    despawnMany(sourceStorage);

    let count = 0;
    querySources(world, Rel, target, () => {
      count += 1;
    });
    expect(count).toBe(0);
  });

  it("ids form removes only the despawned sources", () => {
    const Rel = relation("DMRevCleanIds_Rel");
    const world = createWorld();
    const simple = register(world, archetype([DRSpec_Comp2]));
    const storage = register(world, archetype([DRSpec_Comp, Rel]));

    const target = spawn(simple);
    const source1 = spawn(storage, { DMRevCleanIds_Rel: { target } });
    const source2 = spawn(storage, { DMRevCleanIds_Rel: { target } });
    const source3 = spawn(storage, { DMRevCleanIds_Rel: { target } });

    despawnMany(storage, [source1, source3]);

    expect(getSources(world, Rel, target)).toStrictEqual([source2]);
  });

  it("ids form removes the reverse bucket for a despawned target", () => {
    const Rel = relation("DMRevCleanTarget_Rel");
    const world = createWorld();
    const simple = register(world, archetype([DRSpec_Comp2]));
    const storage = register(world, archetype([DRSpec_Comp, Rel]));

    const target = spawn(simple);
    spawn(storage, { DMRevCleanTarget_Rel: { target } });
    spawn(storage, { DMRevCleanTarget_Rel: { target } });

    despawnMany(simple, [target]);

    expect(getSources(world, Rel, target)).toStrictEqual([]);
  });

  it("no-ids form removes linked optional relations from the reverse map", () => {
    const Rel = relation("DMRevCleanOpt_Rel");
    const world = createWorld();
    const simple = register(world, archetype([DRSpec_Comp2]));
    const storage = register(world, archetype([DRSpec_Comp], [Rel]));

    const target = spawn(simple);
    const source1 = spawn(storage);
    const source2 = spawn(storage);

    link(world, source1, Rel, target);
    link(world, source2, Rel, target);

    despawnMany(storage);

    expect(getSources(world, Rel, target)).toStrictEqual([]);
  });

  it("world no-ids form resets the reverse map and re-initializes relation entries", () => {
    const Rel = relation("DMWorldReset_Rel");
    const world = createWorld();
    const simple = register(world, archetype([DRSpec_Comp2]));
    const storage = register(world, archetype([DRSpec_Comp], [Rel]));

    const target = spawn(simple);
    const source = spawn(storage);
    link(world, source, Rel, target);

    despawnMany(world);

    expect(world.maxTargetIndex).toBe(-1);
    expect(world.reverseMap.size).toBe(world.relations.length);

    // link still works after the reset: the per-relation entries were re-created
    const newTarget = spawn(simple);
    const newSource = spawn(storage);
    link(world, newSource, Rel, newTarget);
    expect(getSources(world, Rel, newTarget)).toStrictEqual([newSource]);
  });

  it("world ids form cleans up across storages", () => {
    const Rel = relation("DMWorldIds_Rel");
    const { DMWorldIds_Other } = components({ DMWorldIds_Other: { v: 0 } });
    const world = createWorld();
    const simple = register(world, archetype([DRSpec_Comp2]));
    const storageA = register(world, archetype([DRSpec_Comp, Rel]));
    const storageB = register(world, archetype([DMWorldIds_Other, Rel]));

    const target = spawn(simple);
    const sourceA = spawn(storageA, { DMWorldIds_Rel: { target } });
    const sourceB = spawn(storageB, { DMWorldIds_Rel: { target } });

    despawnMany(world, [sourceA, sourceB]);

    expect(getSources(world, Rel, target)).toStrictEqual([]);
  });

  it("cascade recipe: getSources → despawn target → despawnMany children", () => {
    const ChildOf = relation("CascadeChildOf");
    const world = createWorld();
    const parents = register(world, archetype([DRSpec_Comp2]));
    const children = register(world, archetype([DRSpec_Comp, ChildOf]));

    const parent = spawn(parents);
    const child1 = spawn(children, { CascadeChildOf: { target: parent } });
    const child2 = spawn(children, { CascadeChildOf: { target: parent } });

    const orphans = getSources(world, ChildOf, parent);
    despawn(parents, parent);
    despawnMany(world, orphans);

    expect(getTarget(world, child1, ChildOf)).toBeUndefined();
    expect(getTarget(world, child2, ChildOf)).toBeUndefined();
    expect(children.n).toBe(0);
    expect(hasSources(world, ChildOf, parent)).toBe(false);
  });
});
