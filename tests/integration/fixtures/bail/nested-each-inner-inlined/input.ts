import { createWorld, each, register, spawn } from "ecstatic";

import { Mover, Statue } from "../../schema.js";

/** Pairs every mover with every statue; the inner each is inlined and the outer keeps its runtime call. */
export function scenario(): unknown {
  const world = createWorld();
  const movers = register(world, Mover);
  const statues = register(world, Statue);
  spawn(movers, { Position: { x: 1, y: 0 } });
  spawn(movers, { Position: { x: 2, y: 0 } });
  spawn(statues, { Health: { hp: 4 } });
  spawn(statues, { Health: { hp: 6 } });
  const pairs: number[][] = [];

  each(movers, (outer) => {
    each(statues, (inner) => {
      pairs.push([outer.id, inner.id, inner.Health.hp]);
    });
  });

  return { pairs };
}
