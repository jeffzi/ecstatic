import { createWorld, each, register, spawn } from "ecstatic";

import { Mover } from "../../schema.js";

/** Scales every row's x through a destructured parameter that a body `var` redeclares, which keeps its value. */
export function scenario(): unknown {
  const world = createWorld();
  const movers = register(world, Mover);
  spawn(movers, { Position: { x: 1, y: 0 } });
  spawn(movers, { Position: { x: 2, y: 0 } });
  const xs: number[] = [];

  // expect-diagnostic: 99914 CALLBACK_PARAMS
  each(movers, ({ Position: { x } }) => {
    // oxlint-disable-next-line no-var -- a var redeclaring the parameter is the behavior under test: the optimizer keeps the runtime call
    var x: number = x * 10;
    xs.push(x);
  });

  return { xs };
}
