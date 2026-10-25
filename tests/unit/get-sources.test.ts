import { describe, expect, it } from "vitest";

import {
  archetype,
  components,
  countSources,
  createWorld,
  despawn,
  getSources,
  querySources,
  register,
  relation,
  spawn,
  spawnMany,
} from "../../src/ecstatic/index.js";

const { GSSpec_Comp, GSSpec_Comp2 } = components({
  GSSpec_Comp: { val: 0 },
  GSSpec_Comp2: { y: 0 },
});

const GSSpec_Rel = relation("GSSpec_Rel");

describe("getSources", () => {
  it("returns all source entity IDs linked to target", () => {
    const world = createWorld();
    const simpleStorage = register(world, archetype([GSSpec_Comp]));
    const storage = register(world, archetype([GSSpec_Comp, GSSpec_Rel]));

    const target = spawn(simpleStorage);
    const source1 = spawn(storage, { GSSpec_Rel: { target } });
    const source2 = spawn(storage, { GSSpec_Rel: { target } });
    const source3 = spawn(storage, { GSSpec_Rel: { target } });

    const result = getSources(world, GSSpec_Rel, target);

    expect(result.length).toBe(3);
    expect(result).toContain(source1);
    expect(result).toContain(source2);
    expect(result).toContain(source3);
  });

  it("returns empty array for target with no sources", () => {
    const world = createWorld();
    const simpleStorage = register(world, archetype([GSSpec_Comp]));
    register(world, archetype([GSSpec_Comp, GSSpec_Rel]));

    const target = spawn(simpleStorage);

    expect(getSources(world, GSSpec_Rel, target)).toStrictEqual([]);
  });

  it("returns empty array for stale/recycled target", () => {
    const world = createWorld();
    const simpleStorage = register(world, archetype([GSSpec_Comp]));
    const storage = register(world, archetype([GSSpec_Comp, GSSpec_Rel]));

    const target = spawn(simpleStorage);
    spawn(storage, { GSSpec_Rel: { target } });
    spawn(storage, { GSSpec_Rel: { target } });

    despawn(simpleStorage, target);

    expect(getSources(world, GSSpec_Rel, target)).toStrictEqual([]);
  });

  it("works across multiple archetypes", () => {
    const world = createWorld();
    const simpleStorage = register(world, archetype([GSSpec_Comp]));
    const storage1 = register(world, archetype([GSSpec_Comp, GSSpec_Rel]));
    const storage2 = register(world, archetype([GSSpec_Comp2, GSSpec_Rel]));

    const target = spawn(simpleStorage);
    const source1 = spawn(storage1, { GSSpec_Rel: { target } });
    const source2 = spawn(storage2, { GSSpec_Rel: { target } });

    const result = getSources(world, GSSpec_Rel, target);

    expect(result.length).toBe(2);
    expect(result).toContain(source1);
    expect(result).toContain(source2);
  });

  it("fills the provided out array and returns the same reference", () => {
    const world = createWorld();
    const simpleStorage = register(world, archetype([GSSpec_Comp]));
    const storage = register(world, archetype([GSSpec_Comp, GSSpec_Rel]));

    const target = spawn(simpleStorage);
    const source1 = spawn(storage, { GSSpec_Rel: { target } });
    const source2 = spawn(storage, { GSSpec_Rel: { target } });

    const out = [source1, source1, source1, source1];
    const result = getSources(world, GSSpec_Rel, target, out);

    expect(result).toBe(out);
    expect(result.length).toBe(2);
    expect(result).toContain(source1);
    expect(result).toContain(source2);
  });

  it("clears the tail when reusing the out array with a smaller result", () => {
    const world = createWorld();
    const simpleStorage = register(world, archetype([GSSpec_Comp]));
    const storage = register(world, archetype([GSSpec_Comp, GSSpec_Rel]));

    const target1 = spawn(simpleStorage);
    spawn(storage, { GSSpec_Rel: { target: target1 } });
    spawn(storage, { GSSpec_Rel: { target: target1 } });
    spawn(storage, { GSSpec_Rel: { target: target1 } });

    const target2 = spawn(simpleStorage);
    const soleSource = spawn(storage, { GSSpec_Rel: { target: target2 } });

    const out = getSources(world, GSSpec_Rel, target1);
    expect(out.length).toBe(3);

    const result = getSources(world, GSSpec_Rel, target2, out);

    expect(result).toBe(out);
    expect(result.length).toBe(1);
    expect(result[0]).toBe(soleSource);
  });

  it("empties the out array on a stale target", () => {
    const world = createWorld();
    const simpleStorage = register(world, archetype([GSSpec_Comp]));
    const storage = register(world, archetype([GSSpec_Comp, GSSpec_Rel]));

    const target = spawn(simpleStorage);
    const source = spawn(storage, { GSSpec_Rel: { target } });
    const out = [source];
    despawn(simpleStorage, target);

    const result = getSources(world, GSSpec_Rel, target, out);

    expect(result).toBe(out);
    expect(result.length).toBe(0);
  });
});

describe("reverse reads after spawnMany", () => {
  it("returns all batch-spawned sources linked to a target", () => {
    const world = createWorld();
    const simpleStorage = register(world, archetype([GSSpec_Comp]));
    const storage = register(world, archetype([GSSpec_Comp, GSSpec_Rel]));

    const target = spawn(simpleStorage);
    spawnMany(storage, 3, { GSSpec_Rel: { target } });

    expect(getSources(world, GSSpec_Rel, target).length).toBe(3);
  });

  it("countSources returns the correct count after batch spawn", () => {
    const world = createWorld();
    const simpleStorage = register(world, archetype([GSSpec_Comp]));
    const storage = register(world, archetype([GSSpec_Comp, GSSpec_Rel]));

    const target = spawn(simpleStorage);
    spawnMany(storage, 5, { GSSpec_Rel: { target } });

    expect(countSources(world, GSSpec_Rel, target)).toBe(5);
  });

  it("querySources visits all batch-spawned sources", () => {
    const world = createWorld();
    const simpleStorage = register(world, archetype([GSSpec_Comp]));
    const storage = register(world, archetype([GSSpec_Comp, GSSpec_Rel]));

    const target = spawn(simpleStorage);
    spawnMany(storage, 4, { GSSpec_Rel: { target } });

    let visited = 0;
    querySources(world, GSSpec_Rel, target, () => {
      visited += 1;
    });
    expect(visited).toBe(4);
  });
});
