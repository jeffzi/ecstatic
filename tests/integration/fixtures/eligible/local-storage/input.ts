import { createWorld, despawnMany, each, get, register, spawn } from "ecstatic";

import { Mover, Position } from "../../schema.js";

/**
 * Moves every row of a storage registered in the same function, then despawns every live id twice.
 *
 * @returns The ids visited by the move, the `x` positions read after the move (`xs`), and `despawnError`, the
 * constructor name of the error `despawnMany` threw, or `"none"` when it threw nothing.
 */
export function scenario(): unknown {
  const world = createWorld();
  const movers = register(world, Mover);
  const ids = [
    spawn(movers, { Position: { x: 1, y: 0 }, Velocity: { dx: 2, dy: 0 } }),
    spawn(movers, { Position: { x: 5, y: 0 }, Velocity: { dx: -1, dy: 0 } }),
  ];
  const visited: number[] = [];

  each(movers, (e) => {
    visited.push(e.id);
    e.Position.x += e.Velocity.dx;
  });

  const xs = ids.map((id) => get(movers, id, Position.x));
  let despawnError = "none";
  try {
    despawnMany(movers, [...ids, ...ids]);
  } catch (error) {
    despawnError = error instanceof Error ? error.constructor.name : typeof error;
  }

  return { visited, xs, despawnError };
}
