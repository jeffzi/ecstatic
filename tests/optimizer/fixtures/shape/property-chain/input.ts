import { createWorld, each, get, register, spawn, type Storage } from "ecstatic";

import { Mover, Position } from "../../schema.js";

interface Game {
  readonly level: { readonly movers: Storage<typeof Mover> };
}

/** Moves every row of a storage reached through a chain of property accesses. */
export function scenario(): unknown {
  const game: Game = { level: { movers: register(createWorld(), Mover) } };
  const ids = [
    spawn(game.level.movers, { Position: { x: 4, y: 0 }, Velocity: { dx: 1, dy: 0 } }),
    spawn(game.level.movers, { Position: { x: 9, y: 0 }, Velocity: { dx: -6, dy: 0 } }),
  ];
  const visited: number[] = [];

  each(game.level.movers, (e) => {
    visited.push(e.id);
    e.Position.x += e.Velocity.dx;
  });

  return { visited, xs: ids.map((id) => get(game.level.movers, id, Position.x)) };
}
