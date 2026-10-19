import { createWorld, each, register, spawn } from "ecstatic";

import { Mover } from "../../schema.js";

/** Stores the view itself in a local, then reads every row's id through it. */
export function scenario(): unknown {
  const world = createWorld();
  const movers = register(world, Mover);
  spawn(movers, { Position: { x: 1, y: 0 } });
  spawn(movers, { Position: { x: 2, y: 0 } });
  const visited: number[] = [];

  // expect-diagnostic: 99918 VIEW_ESCAPES
  each(movers, (e) => {
    const view = e;
    visited.push(view.id);
  });

  return { visited };
}
