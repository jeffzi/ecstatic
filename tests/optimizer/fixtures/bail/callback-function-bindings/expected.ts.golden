import { createWorld, each, get, register, spawn } from "ecstatic";

import { Mover, Position } from "../../schema.js";

/** Moves every row with a named function expression that refers to itself. */
export function scenario(): unknown {
  const world = createWorld();
  const movers = register(world, Mover);
  const ids = [
    spawn(movers, { Position: { x: 1, y: 0 } }),
    spawn(movers, { Position: { x: 2, y: 0 } }),
  ];
  const names: string[] = [];

  // expect-diagnostic: 99917 CALLBACK_FUNCTION_BINDINGS
  each(movers, function tally(e) {
    e.Position.x += 1;
    names.push(tally.name);
  });

  return { names, xs: ids.map((id) => get(movers, id, Position.x)) };
}
