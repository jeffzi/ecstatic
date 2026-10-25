import { createWorld, each, get, register, spawn } from "ecstatic";

import { Mover, Position } from "../../schema.js";

/** Writes every row's position through a destructuring assignment whose targets are fields. */
export function scenario(): unknown {
  const world = createWorld();
  const movers = register(world, Mover);
  const ids = [
    spawn(movers, { Position: { x: 1, y: 2 } }),
    spawn(movers, { Position: { x: 3, y: 4 } }),
  ];

  // expect-diagnostic: 99919 UNSUPPORTED_ASSIGNMENT 3
  each(movers, (e) => {
    [e.Position.x, e.Position.y] = [e.Position.y, e.Position.x];
  });

  return {
    xs: ids.map((id) => get(movers, id, Position.x)),
    ys: ids.map((id) => get(movers, id, Position.y)),
  };
}
