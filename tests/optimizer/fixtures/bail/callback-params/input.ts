import { createWorld, each, get, register, spawn } from "ecstatic";

import { Mover, Position } from "../../schema.js";

/** Moves every row with a callback that takes a defaulted second parameter. */
export function scenario(): unknown {
  const world = createWorld();
  const movers = register(world, Mover);
  const ids = [
    spawn(movers, { Position: { x: 1, y: 0 } }),
    spawn(movers, { Position: { x: 2, y: 0 } }),
  ];

  // expect-diagnostic: 99914 CALLBACK_PARAMS 3
  each(movers, (e, step = 3) => {
    e.Position.x += step;
  });

  return { xs: ids.map((id) => get(movers, id, Position.x)) };
}
