import { createWorld, each, get, register, spawn, type Storage, type World } from "ecstatic";

import { Mover, Position } from "../../schema.js";

class Fleet {
  readonly movers: Storage<typeof Mover>;

  constructor(world: World) {
    this.movers = register(world, Mover);
  }

  advance(visited: number[]): void {
    each(this.movers, (e) => {
      visited.push(e.id);
      e.Position.x += e.Velocity.dx;
    });
  }
}

/** Moves every row of a storage held in a class field and read through `this`. */
export function scenario(): unknown {
  const fleet = new Fleet(createWorld());
  const ids = [
    spawn(fleet.movers, { Position: { x: 3, y: 0 }, Velocity: { dx: 2, dy: 0 } }),
    spawn(fleet.movers, { Position: { x: 8, y: 0 }, Velocity: { dx: -4, dy: 0 } }),
  ];
  const visited: number[] = [];

  fleet.advance(visited);

  return { visited, xs: ids.map((id) => get(fleet.movers, id, Position.x)) };
}
