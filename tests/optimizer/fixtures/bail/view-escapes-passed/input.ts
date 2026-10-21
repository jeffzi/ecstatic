import { createWorld, each, register, spawn } from "ecstatic";

import { Mover } from "../../schema.js";

/** Collects the id of every row through a helper that receives the view itself. */
export function scenario(): unknown {
  const world = createWorld();
  const movers = register(world, Mover);
  spawn(movers, { Position: { x: 1, y: 0 } });
  spawn(movers, { Position: { x: 2, y: 0 } });
  const visited: number[] = [];
  const record = (view: { readonly id: number }): void => {
    visited.push(view.id);
  };

  // expect-diagnostic: 99918 VIEW_ESCAPES 3 `line 18, column 12: the view as a value`
  each(movers, (e) => {
    record(e);
  });

  return { visited };
}
