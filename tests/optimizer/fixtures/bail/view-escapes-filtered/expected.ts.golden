import { createWorld, each, register, spawn } from "ecstatic";

import { Mover, Velocity } from "../../schema.js";

/** Collects every row of a filtered each through a helper that receives the view itself. */
export function scenario(): unknown {
  const world = createWorld();
  const movers = register(world, Mover);
  spawn(movers, { Position: { x: 1, y: 0 } });
  spawn(movers, { Position: { x: 2, y: 0 } });
  const visited: number[] = [];
  const record = (view: { readonly id: number }): void => {
    visited.push(view.id);
  };

  // expect-diagnostic: 99918 VIEW_ESCAPES
  each(movers, [Velocity], (e) => {
    record(e);
  });

  return { visited };
}
