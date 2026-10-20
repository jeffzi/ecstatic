import { createWorld, each, register, spawn } from "ecstatic";

import { Mover } from "../../schema.js";

/** Replaces every row's required data slot with a plain record, then reads a field back through the view. */
export function scenario(): unknown {
  const world = createWorld();
  const movers = register(world, Mover);
  spawn(movers, { Position: { x: 1, y: 0 } });
  spawn(movers, { Position: { x: 2, y: 0 } });
  const xs: number[] = [];

  // expect-diagnostic: 99918 VIEW_ESCAPES
  each(movers, (e) => {
    e.Position = { x: e.Position.x * 10, y: 0 };
    xs.push(e.Position.x);
  });

  return { xs };
}
