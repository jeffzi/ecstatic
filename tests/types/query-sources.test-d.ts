import { describe, expectTypeOf, it } from "vitest";

import type { EntityId } from "../../src/index.js";
import {
  archetype,
  createWorld,
  getSources,
  querySources,
  register,
  relation,
  spawn,
} from "../../src/index.js";
import { Position, Shield, Stunned } from "./_fixtures.js";

const PureRel = relation("QSTd_Pure");
const DataRel = relation("QSTd_Data", [], { weight: 0 });

const world = createWorld();
const simple = register(world, archetype([Position]));
register(world, archetype([Position, DataRel], [Shield, Stunned]));
register(world, archetype([Position], [PureRel]));
const target = spawn(simple);

describe("querySources view typing", () => {
  it("types the relation as present with its data fields accessible", () => {
    querySources(world, DataRel, target, (view) => {
      expectTypeOf(view.id).toExtend<EntityId>();
      expectTypeOf(view.QSTd_Data.weight).toEqualTypeOf<number>();
    });
  });

  it("does not expose the target through the view", () => {
    querySources(world, DataRel, target, (view) => {
      // @ts-expect-error the target column is not part of the view — use getTarget()
      void view.QSTd_Data.target;
    });
  });

  it("types a pure link relation as a literal-true slot", () => {
    querySources(world, PureRel, target, (view) => {
      expectTypeOf(view.QSTd_Pure).toEqualTypeOf<true>();
    });
  });

  it("narrows filter axes like query: all promotes, any stays optional", () => {
    querySources(world, DataRel, target, { all: [Shield], any: [Stunned] }, (view) => {
      expectTypeOf(view.Shield.hp).toEqualTypeOf<number>();
      expectTypeOf(view.Stunned).toEqualTypeOf<true | undefined>();
    });
  });

  it("accepts a filter with only none (no all axis)", () => {
    querySources(world, DataRel, target, { none: [Stunned] }, (view) => {
      expectTypeOf(view.QSTd_Data.weight).toEqualTypeOf<number>();
      expectTypeOf(view.id).toExtend<EntityId>();
    });
  });

  it("accepts a filter with any and none (no all axis)", () => {
    querySources(world, DataRel, target, { any: [Shield], none: [Stunned] }, (view) => {
      expectTypeOf(view.QSTd_Data.weight).toEqualTypeOf<number>();
      if (view.Shield !== undefined) {
        expectTypeOf(view.Shield.hp).toEqualTypeOf<number>();
      }
    });
  });

  it("accepts the component-array shorthand as {all}", () => {
    querySources(world, DataRel, target, [Shield], (view) => {
      expectTypeOf(view.Shield.hp).toEqualTypeOf<number>();
    });
  });
});

describe("getSources typing", () => {
  it("returns entity ids and reuses a typed out array", () => {
    expectTypeOf(getSources(world, DataRel, target)).toEqualTypeOf<EntityId[]>();
    const out: EntityId[] = [];
    expectTypeOf(getSources(world, DataRel, target, out)).toEqualTypeOf<EntityId[]>();
  });
});
