import { Archetype, createWorld, each, get, register, spawn, type Storage } from "ecstatic";

import { Position, Velocity } from "../../schema.js";

class Runner extends Archetype([Position, Velocity]) {}

function advance(runners: Storage<Runner>, visited: number[]): void {
  each(runners, (e) => {
    visited.push(e.id);
    e.Position.y += e.Velocity.dy;
  });
}

/** Moves every row of a storage reached through a parameter typed with a class-form archetype. */
export function scenario(): unknown {
  const runners = register(createWorld(), Runner);
  const ids = [
    spawn(runners, { Position: { x: 0, y: 2 }, Velocity: { dx: 0, dy: 5 } }),
    spawn(runners, { Position: { x: 0, y: 7 }, Velocity: { dx: 0, dy: -3 } }),
  ];
  const visited: number[] = [];

  advance(runners, visited);

  return { visited, ys: ids.map((id) => get(runners, id, Position.y)) };
}
