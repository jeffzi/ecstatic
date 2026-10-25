import { createWorld, each, register, spawn } from "ecstatic";

import { Mover } from "../../schema.js";

/** Reads every row's x through an arrow function declared in the callback and called at once. */
export function scenario(): unknown {
  const world = createWorld();
  const movers = register(world, Mover);
  spawn(movers, { Position: { x: 1, y: 0 } });
  spawn(movers, { Position: { x: 2, y: 0 } });
  const xs: number[] = [];

  // expect-diagnostic: 99918 VIEW_ESCAPES 3 `line 15, column 33: a reference from a nested function`
  each(movers, (e) => {
    const readX = (): number => e.Position.x;
    xs.push(readX());
  });

  return { xs };
}
