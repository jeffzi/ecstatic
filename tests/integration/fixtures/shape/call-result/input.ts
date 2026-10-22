import { createWorld, each, get, register, spawn, type Storage } from "ecstatic";

import { Mover, Position } from "../../schema.js";

interface Level {
  readonly movers: Storage<typeof Mover>;
}

function moversOf(level: Level): Storage<typeof Mover> {
  return level.movers;
}

/** Moves every row of a storage returned by a function call. */
export function scenario(): unknown {
  const level: Level = { movers: register(createWorld(), Mover) };
  const ids = [
    spawn(level.movers, { Position: { x: 6, y: 0 }, Velocity: { dx: 3, dy: 0 } }),
    spawn(level.movers, { Position: { x: 1, y: 0 }, Velocity: { dx: 5, dy: 0 } }),
  ];
  const visited: number[] = [];

  each(moversOf(level), (e) => {
    visited.push(e.id);
    e.Position.x += e.Velocity.dx;
  });

  return { visited, xs: ids.map((id) => get(level.movers, id, Position.x)) };
}
