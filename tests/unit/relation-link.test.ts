import { describe, expect, it } from "vitest";

import { archetype } from "../../src/ecstatic/archetype.js";
import { components, ref } from "../../src/ecstatic/component.js";
import { get, getTarget } from "../../src/ecstatic/entity/access.js";
import { each } from "../../src/ecstatic/entity/each.js";
import { link, unlink } from "../../src/ecstatic/entity/relation.js";
import { spawn } from "../../src/ecstatic/entity/spawn.js";
import { getSources, spawnMany } from "../../src/ecstatic/index.js";
import { relation } from "../../src/ecstatic/relation.js";
import { createWorld, register } from "../../src/ecstatic/world.js";
import { despawnOnRead } from "./fixtures.js";

const { RelSpec_Comp } = components({ RelSpec_Comp: { x: 0, y: 0 } });

describe("link/unlink archetype guard", () => {
  it("link errors when relation not on archetype", () => {
    const OnArch = relation("ArchGuard_OnArch");
    const NotOnArch = relation("ArchGuard_NotOnArch");
    const world = createWorld();
    const simpleStorage = register(world, archetype([RelSpec_Comp]));
    const storage = register(world, archetype([RelSpec_Comp, OnArch]));

    const targetId = spawn(simpleStorage);
    const entityId = spawn(storage, { ArchGuard_OnArch: { target: targetId } });

    expect(() => {
      link(world, entityId, NotOnArch, targetId);
    }).toThrow("relation not on this entity's archetype");
  });

  it("unlink errors when relation not on archetype", () => {
    const OnArch = relation("ArchGuard_OnArch2");
    const NotOnArch = relation("ArchGuard_NotOnArch2");
    const world = createWorld();
    const simpleStorage = register(world, archetype([RelSpec_Comp]));
    const storage = register(world, archetype([RelSpec_Comp, OnArch]));

    const targetId = spawn(simpleStorage);
    const entityId = spawn(storage, { ArchGuard_OnArch2: { target: targetId } });

    expect(() => {
      unlink(world, entityId, NotOnArch);
    }).toThrow("relation not on this entity's archetype");
  });
});

describe("filtered each reflects link/unlink mutations", () => {
  it("filtered each reflects a newly linked optional relation", () => {
    const Rel = relation("LinkMatcherCache_Rel");
    const world = createWorld();
    const storage = register(world, archetype([RelSpec_Comp], [Rel]));

    const targetId = spawn(storage);
    const sourceId = spawn(storage);

    let matchedCountBefore = 0;
    each(storage, { all: [Rel] }, () => {
      matchedCountBefore += 1;
    });
    expect(matchedCountBefore).toBe(0);

    link(world, sourceId, Rel, targetId);

    let matchedCountAfter = 0;
    each(storage, { all: [Rel] }, (e) => {
      matchedCountAfter += 1;
      expect(e.id).toBe(sourceId);
    });
    expect(matchedCountAfter).toBe(1);
  });

  it("filtered each excludes unlinked optional relation", () => {
    const Rel = relation("UnlinkMatcherCache_Rel");
    const world = createWorld();
    const storage = register(world, archetype([RelSpec_Comp], [Rel]));

    // Establish the relation with link() before any matcher exists — with no
    // matchers yet, link()'s own refresh is a no-op, so this isolates unlink().
    const targetId = spawn(storage);
    const sourceId = spawn(storage);
    link(world, sourceId, Rel, targetId);

    let matchedCountBefore = 0;
    each(storage, { all: [Rel] }, (e) => {
      matchedCountBefore += 1;
      expect(e.id).toBe(sourceId);
    });
    expect(matchedCountBefore).toBe(1);

    unlink(world, sourceId, Rel);

    let matchedCountAfter = 0;
    each(storage, { all: [Rel] }, () => {
      matchedCountAfter += 1;
    });
    expect(matchedCountAfter).toBe(0);
  });
});

describe("link value cloning", () => {
  it("link stores object values by reference — mutating the caller object affects stored state", () => {
    const LinkRefTest = relation("LinkRefTest", [], {
      config: ref<{ enabled: boolean; timeout: number }>(),
    });
    const world = createWorld();
    const storage = register(world, archetype([RelSpec_Comp, LinkRefTest]));
    const simpleStorage = register(world, archetype([RelSpec_Comp]));

    const targetId = spawn(simpleStorage);
    const sourceId = spawn(storage, { LinkRefTest: { target: targetId } });

    const configObj = { enabled: true, timeout: 1000 };
    link(world, sourceId, LinkRefTest, targetId, { config: configObj });
    configObj.enabled = false;
    configObj.timeout = 9999;

    // Reference semantics: the stored value IS the caller's object
    const storedConfig = get(storage, sourceId, LinkRefTest.config);
    expect(storedConfig).toBe(configObj);
    expect(storedConfig?.enabled).toBe(false);
    expect(storedConfig?.timeout).toBe(9999);
  });
});

describe("link values reads", () => {
  /** Builds a storage with an optional relation `name`, two targets beside an unlinked source in it. */
  function createOptionalLink(name: string) {
    const Rel = relation(name, [], { weight: 0, kind: 0 });
    const world = createWorld();
    const storage = register(world, archetype([RelSpec_Comp], [Rel]));
    const firstTarget = spawn(storage);
    const secondTarget = spawn(storage);
    const sourceId = spawn(storage);
    return { Rel, world, storage, firstTarget, secondTarget, sourceId };
  }

  /** Builds a storage with a required relation `name`, a source born linked to `firstTarget`, and both targets in a separate storage. */
  function createRequiredLink(name: string) {
    const Rel = relation(name, [], { weight: 0, kind: 0 });
    const world = createWorld();
    const storage = register(world, archetype([RelSpec_Comp, Rel]));
    const targetStorage = register(world, archetype([RelSpec_Comp]));
    const firstTarget = spawn(targetStorage);
    const secondTarget = spawn(targetStorage);
    const sourceId = spawn(storage, { [name]: { target: firstTarget } });
    return { Rel, world, storage, firstTarget, secondTarget, sourceId };
  }

  it("optional relation writes a getter value that grows the storage, reading it once", () => {
    const { Rel, world, storage, firstTarget, sourceId } = createOptionalLink("LinkReadOpt_Rel");
    let reads = 0;
    const values = {
      get weight(): number {
        reads += 1;
        spawnMany(storage, 16);
        return 3;
      },
    };

    link(world, sourceId, Rel, firstTarget, values);

    expect(get(storage, sourceId, Rel.weight)).toBe(3);
    expect(getTarget(world, sourceId, Rel)).toBe(firstTarget);
    expect(getSources(world, Rel, firstTarget)).toStrictEqual([sourceId]);
    expect(reads).toBe(1);
  });

  it("required relation writes a getter value that grows the storage, reading it once", () => {
    const name = "LinkReadReq_Rel";
    const { Rel, world, storage, firstTarget, secondTarget, sourceId } = createRequiredLink(name);
    let reads = 0;
    const values = {
      get weight(): number {
        reads += 1;
        spawnMany(storage, 16, { [name]: { target: firstTarget } });
        return 3;
      },
    };

    link(world, sourceId, Rel, secondTarget, values);

    expect(get(storage, sourceId, Rel.weight)).toBe(3);
    expect(getTarget(world, sourceId, Rel)).toBe(secondTarget);
    expect(getSources(world, Rel, secondTarget)).toStrictEqual([sourceId]);
    expect(getSources(world, Rel, firstTarget)).not.toContain(sourceId);
    expect(reads).toBe(1);
  });

  it("optional relation writes a getter value that despawns an earlier sibling to the moved row", () => {
    const { Rel, world, storage, firstTarget, secondTarget, sourceId } =
      createOptionalLink("LinkDespawnOpt_Rel");
    const values = despawnOnRead(storage, secondTarget, "weight", 3);

    link(world, sourceId, Rel, firstTarget, values);

    expect(get(storage, sourceId, Rel.weight)).toBe(3);
    expect(getTarget(world, sourceId, Rel)).toBe(firstTarget);
  });

  it.each([
    { path: "optional relation", create: createOptionalLink, name: "LinkKeepOpt_Rel" },
    { path: "required relation", create: createRequiredLink, name: "LinkKeepReq_Rel" },
  ])("$path keeps the current value of an absent or undefined field", ({ create, name }) => {
    const { Rel, world, storage, firstTarget, secondTarget, sourceId } = create(name);
    link(world, sourceId, Rel, firstTarget, { weight: 3, kind: 4 });

    // @ts-expect-error the types reject an explicit undefined; JavaScript callers can still pass one
    link(world, sourceId, Rel, secondTarget, { weight: undefined });

    expect(get(storage, sourceId, Rel.weight)).toBe(3);
    expect(get(storage, sourceId, Rel.kind)).toBe(4);
  });
});
