import { createWorld, each, get, register, spawn } from "ecstatic";

import { Mover, Position } from "../../schema.js";

/** Moves every row by an amount a direct eval computes, which could reach the view. */
export function scenario(): unknown {
  const world = createWorld();
  const movers = register(world, Mover);
  const ids = [
    spawn(movers, { Position: { x: 1, y: 0 } }),
    spawn(movers, { Position: { x: 2, y: 0 } }),
  ];

  // expect-diagnostic: 99918 VIEW_ESCAPES 3 `line 17, column 26: a direct eval`
  each(movers, (e) => {
    // oxlint-disable-next-line no-eval -- a direct eval in the body is the behavior under test: the optimizer keeps the runtime call
    const step: number = eval("2 * 3");
    e.Position.x += step;
  });

  return { xs: ids.map((id) => get(movers, id, Position.x)) };
}
