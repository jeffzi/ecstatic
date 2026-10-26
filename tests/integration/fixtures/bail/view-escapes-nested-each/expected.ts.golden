import { createWorld, each, register, spawn } from "ecstatic";

import { Mover, Statue } from "../../schema.js";

/** Pairs every mover with every statue from an inner each over an array literal, which keeps its runtime call. */
export function scenario(): unknown {
  const world = createWorld();
  const movers = register(world, Mover);
  const statues = register(world, Statue);
  spawn(movers, { Position: { x: 1, y: 0 } });
  spawn(movers, { Position: { x: 2, y: 0 } });
  spawn(statues, { Health: { hp: 4 } });
  const pairs: number[][] = [];

  // expect-diagnostic: 99918 VIEW_ESCAPES 3 `line 18, column 19: a reference from a nested callback that keeps its runtime call`
  each(movers, (outer) => {
    each([statues], (inner) => {
      pairs.push([outer.id, inner.id]);
    });
  });

  return { pairs };
}
