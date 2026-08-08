import { describe, expectTypeOf, it } from "vitest";

import type { EntityId, With } from "../../src/index.js";
import {
  archetype,
  createWorld,
  getTarget,
  link,
  register,
  relation,
  spawn,
  unlink,
} from "../../src/index.js";
import { Health, Position } from "./_fixtures.js";

const Owner = relation("LinkTd_Owner", [Position]);
const Free = relation("LinkTd_Free");
const DataRel = relation("LinkTd_Data", [], { weight: 0 });

const world = createWorld();
const movers = register(world, archetype([Position], [Owner, Free, DataRel]));
const healthy = register(world, archetype([Health]));
const source = spawn(movers);
const positionTarget = spawn(movers);
const healthTarget = spawn(healthy);

describe("link", () => {
  it("constrains the target to entities carrying the constraint components", () => {
    link(world, source, Owner, positionTarget);
    // @ts-expect-error the target's archetype lacks Position
    link(world, source, Owner, healthTarget);
  });

  it("admits any entity for an unconstrained relation", () => {
    link(world, source, Free, positionTarget);
    link(world, source, Free, healthTarget);
  });

  it("types values as the relation's data fields only", () => {
    link(world, source, DataRel, positionTarget, { weight: 2 });
    link(world, source, DataRel, positionTarget, {});
    // @ts-expect-error "wrong" is not a field of the relation
    link(world, source, DataRel, positionTarget, { wrong: 2 });
    // @ts-expect-error target is not a data field — it is the link column
    link(world, source, DataRel, positionTarget, { target: positionTarget });
    // @ts-expect-error string is not assignable to number
    link(world, source, DataRel, positionTarget, { weight: "oops" });
  });
});

describe("getTarget", () => {
  it("returns the constraint-shaped id or undefined", () => {
    const target = getTarget(world, source, Owner);
    expectTypeOf(target).toExtend<With<[typeof Position]> | undefined>();
    expectTypeOf(target).toExtend<EntityId | undefined>();
  });

  it("feeds back into link after a non-undefined narrow", () => {
    const target = getTarget(world, source, Owner);
    if (target !== undefined) {
      link(world, source, Owner, target);
    }
  });
});

describe("unlink", () => {
  it("accepts a relation descriptor", () => {
    unlink(world, source, Free);
  });
});
