import { describe, expect, it } from "vitest";

import { archetype } from "../../src/ecstatic/archetype.js";
import { components, ref } from "../../src/ecstatic/component.js";
import { get } from "../../src/ecstatic/entity/access.js";
import { each } from "../../src/ecstatic/entity/each.js";
import { link, unlink } from "../../src/ecstatic/entity/relation.js";
import { spawn } from "../../src/ecstatic/entity/spawn.js";
import { relation } from "../../src/ecstatic/relation.js";
import { createWorld, register } from "../../src/ecstatic/world.js";

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
