import { Archetype, createWorld, each, get, register, spawn } from "ecstatic";

import { Position, Velocity } from "../../schema.js";

class Runner extends Archetype([Position, Velocity]) {}

/** Moves every row of a storage registered from a class-form archetype. */
export function scenario(): unknown {
  const world = createWorld();
  const runners = register(world, Runner);
  const ids = [
    spawn(runners, { Position: { x: 0, y: 1 }, Velocity: { dx: 0, dy: 3 } }),
    spawn(runners, { Position: { x: 0, y: 4 }, Velocity: { dx: 0, dy: -2 } }),
  ];
  const visited: number[] = [];

  each(runners, (e) => {
    visited.push(e.id);
    e.Position.y += e.Velocity.dy;
  });

  return { visited, ys: ids.map((id) => get(runners, id, Position.y)) };
}
