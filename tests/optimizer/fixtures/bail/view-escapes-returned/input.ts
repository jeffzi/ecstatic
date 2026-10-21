import { createWorld, each, register, spawn } from "ecstatic";

import { Mover } from "../../schema.js";

/** Returns the view itself from the callback on rows past the first position, which the runtime discards. */
export function scenario(): unknown {
  const world = createWorld();
  const movers = register(world, Mover);
  spawn(movers, { Position: { x: 1, y: 0 } });
  spawn(movers, { Position: { x: 2, y: 0 } });
  const visited: number[] = [];

  // expect-diagnostic: 99918 VIEW_ESCAPES 3 `line 16, column 12: the view as a value`
  each(movers, (e) => {
    visited.push(e.id);
    return e;
  });

  return { visited };
}
