import { each, get, spawn } from "ecstatic";

import { Position } from "../../schema.js";
import { crowd } from "./storage.js";

/** Moves every row of a storage registered in a sibling module. */
export function scenario(): unknown {
  const ids = [
    spawn(crowd, { Position: { x: 2, y: 0 }, Velocity: { dx: 3, dy: 0 } }),
    spawn(crowd, { Position: { x: 6, y: 0 }, Velocity: { dx: -2, dy: 0 } }),
  ];
  const visited: number[] = [];

  each(crowd, (e) => {
    visited.push(e.id);
    e.Position.x += e.Velocity.dx;
  });

  return { visited, xs: ids.map((id) => get(crowd, id, Position.x)) };
}
