import { createWorld, each, register, spawn } from "ecstatic";

import { Mover } from "../../schema.js";

/** Assigns the view itself to an outer binding on every row, which outlives the callback. */
export function scenario(): unknown {
  const world = createWorld();
  const movers = register(world, Mover);
  spawn(movers, { Position: { x: 1, y: 0 } });
  spawn(movers, { Position: { x: 2, y: 0 } });
  let last: unknown = undefined;
  let rows = 0;

  // expect-diagnostic: 99918 VIEW_ESCAPES
  each(movers, (e) => {
    last = e;
    rows += 1;
  });

  return { assigned: last !== undefined, rows };
}
