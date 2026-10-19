import { createWorld, each, get, register, spawn, type Storage } from "ecstatic";

import { Mover, Position } from "../../schema.js";

/** Moves every row of a wide storage cast back to the archetype it was registered with. */
export function scenario(): unknown {
  const movers = register(createWorld(), Mover);
  const ids = [
    spawn(movers, { Position: { x: 1, y: 0 }, Velocity: { dx: 6, dy: 0 } }),
    spawn(movers, { Position: { x: 4, y: 0 }, Velocity: { dx: -1, dy: 0 } }),
  ];
  const wide: Storage = movers;
  const visited: number[] = [];

  each(wide as Storage<typeof Mover>, (e) => {
    visited.push(e.id);
    e.Position.x += e.Velocity.dx;
  });

  return { visited, xs: ids.map((id) => get(movers, id, Position.x)) };
}
