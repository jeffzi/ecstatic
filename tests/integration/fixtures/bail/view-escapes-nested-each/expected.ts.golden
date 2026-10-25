import { createWorld, each, register, spawn } from "ecstatic";

import { Health, Mover, Statue } from "../../schema.js";

/** Pairs every mover with every statue from a filtered inner each, which keeps its runtime call. */
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
    each(statues, [Health], (inner) => {
      pairs.push([outer.id, inner.id]);
    });
  });

  return { pairs };
}
