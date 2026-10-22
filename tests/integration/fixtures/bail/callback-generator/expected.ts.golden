import { createWorld, each, get, register, spawn } from "ecstatic";

import { Mover, Position } from "../../schema.js";

/** Passes a generator callback, whose body never runs because nothing iterates the generators. */
export function scenario(): unknown {
  const world = createWorld();
  const movers = register(world, Mover);
  const ids = [
    spawn(movers, { Position: { x: 1, y: 0 } }),
    spawn(movers, { Position: { x: 2, y: 0 } }),
  ];

  // expect-diagnostic: 99916 CALLBACK_GENERATOR 3
  each(movers, function* (e) {
    e.Position.x = 99;
    yield e.id;
  });

  return { xs: ids.map((id) => get(movers, id, Position.x)) };
}
