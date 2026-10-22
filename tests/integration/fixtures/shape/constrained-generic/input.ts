import { createWorld, each, get, register, spawn, type Storage } from "ecstatic";

import { Mover, Position } from "../../schema.js";

function advance<S extends Storage<typeof Mover>>(movers: S, visited: number[]): S {
  each(movers, (e) => {
    visited.push(e.id);
    e.Position.x += e.Velocity.dx;
  });
  return movers;
}

/** Moves every row of a storage reached through a type parameter constrained to a storage type. */
export function scenario(): unknown {
  const movers = register(createWorld(), Mover);
  const ids = [
    spawn(movers, { Position: { x: 7, y: 0 }, Velocity: { dx: 1, dy: 0 } }),
    spawn(movers, { Position: { x: 2, y: 0 }, Velocity: { dx: 3, dy: 0 } }),
  ];
  const visited: number[] = [];

  const advanced = advance(movers, visited);

  return { visited, xs: ids.map((id) => get(advanced, id, Position.x)) };
}
