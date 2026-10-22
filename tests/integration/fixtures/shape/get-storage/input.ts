import { createWorld, each, get, getStorage, register, spawn } from "ecstatic";

import { Mover, Position } from "../../schema.js";

/** Moves every row of a storage looked up with `getStorage`. */
export function scenario(): unknown {
  const world = createWorld();
  const movers = register(world, Mover);
  const ids = [
    spawn(movers, { Position: { x: 2, y: 0 }, Velocity: { dx: 7, dy: 0 } }),
    spawn(movers, { Position: { x: 5, y: 0 }, Velocity: { dx: -2, dy: 0 } }),
  ];
  const visited: number[] = [];

  each(getStorage(world, Mover), (e) => {
    visited.push(e.id);
    e.Position.x += e.Velocity.dx;
  });

  return { visited, xs: ids.map((id) => get(movers, id, Position.x)) };
}
