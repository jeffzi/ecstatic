import { describe, expect, it } from "vitest";

import { archetype } from "../../src/ecstatic/archetype.js";
import { components } from "../../src/ecstatic/component.js";
import { type EntityId, MAX_GEN } from "../../src/ecstatic/entity-id.js";
import { getTarget } from "../../src/ecstatic/entity/access.js";
import { despawn } from "../../src/ecstatic/entity/despawn.js";
import { link } from "../../src/ecstatic/entity/relation.js";
import { spawn } from "../../src/ecstatic/entity/spawn.js";
import { countSources, hasSources } from "../../src/ecstatic/index.js";
import { relation } from "../../src/ecstatic/relation.js";
import type { World } from "../../src/ecstatic/world.js";
import { createWorld, register } from "../../src/ecstatic/world.js";

const { WrapSpec_Comp } = components({ WrapSpec_Comp: { x: 0, y: 0 } });
const WrapSpec_Rel = relation("WrapSpec_Rel");

/**
 * World where `held` is a dead id whose slot is free and whose next id is `held` again.
 *
 * The slot was despawned 1,023 times in total, each despawn but the last
 * followed by a respawn, so its generation wrapped back to the one `held`
 * carries. `source` is a live entity able to link through `WrapSpec_Rel`.
 */
function createWrappedFreeTarget() {
  const world = createWorld();
  const storage = register(world, archetype([WrapSpec_Comp], [WrapSpec_Rel]));
  const source = spawn(storage, { WrapSpec_Comp: { x: 1, y: 2 } });
  const held = spawn(storage);
  let occupant = held;
  for (let i = 1; i < MAX_GEN - 1; i++) {
    despawn(storage, occupant);
    occupant = spawn(storage);
  }
  despawn(storage, occupant);
  return { held, source, storage, world };
}

/** Links `source` to `target` through `WrapSpec_Rel`, discarding the error a rejected link throws. */
function attemptLink(world: World, source: EntityId, target: EntityId): void {
  try {
    link(world, source, WrapSpec_Rel, target);
  } catch {
    // A rejected link is the case under test: only its side effects matter.
  }
}

describe("a dead id whose slot is free after the generation wraps", () => {
  it("is a stale link target #checked", () => {
    const { held, source, world } = createWrappedFreeTarget();

    expect(() => {
      link(world, source, WrapSpec_Rel, held);
    }).toThrow("stale target ID for relation WrapSpec_Rel");
  });

  it("gains no sources from a rejected link", () => {
    const { held, source, world } = createWrappedFreeTarget();

    attemptLink(world, source, held);

    expect(hasSources(world, WrapSpec_Rel, held)).toBe(false);
    expect(countSources(world, WrapSpec_Rel, held)).toBe(0);
  });

  it("leaves no sources for the slot's next occupant after a rejected link #checked", () => {
    const { held, source, storage, world } = createWrappedFreeTarget();
    attemptLink(world, source, held);

    const next = spawn(storage);

    expect(countSources(world, WrapSpec_Rel, next)).toBe(0);
  });

  it("has no target", () => {
    const { held, world } = createWrappedFreeTarget();

    expect(getTarget(world, held, WrapSpec_Rel)).toBeUndefined();
  });
});
