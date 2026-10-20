import { createWorld, each, get, register, spawn, type Storage } from "ecstatic";

import { Mover, Position } from "../../schema.js";

function advance(movers: Storage<typeof Mover>, visited: number[]): void {
  each(movers, (e) => {
    visited.push(e.id);
    e.Position.x += e.Velocity.dx;
  });
}

/** Moves every row of a storage reached through a parameter typed with its archetype. */
export function scenario(): unknown {
  const world = createWorld();
  const movers = register(world, Mover);
  const ids = [
    spawn(movers, { Position: { x: 1, y: 0 }, Velocity: { dx: 4, dy: 0 } }),
    spawn(movers, { Position: { x: 3, y: 0 }, Velocity: { dx: 1, dy: 0 } }),
  ];
  const visited: number[] = [];

  advance(movers, visited);

  return { visited, xs: ids.map((id) => get(movers, id, Position.x)) };
}
