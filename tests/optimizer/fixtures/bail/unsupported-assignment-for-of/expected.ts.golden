import { createWorld, each, get, register, spawn } from "ecstatic";

import { Mover, Position } from "../../schema.js";

/** Writes every row's position through a `for…of` head whose target is a field. */
export function scenario(): unknown {
  const world = createWorld();
  const movers = register(world, Mover);
  const ids = [
    spawn(movers, { Position: { x: 1, y: 2 } }),
    spawn(movers, { Position: { x: 3, y: 4 } }),
  ];
  const seen: number[] = [];

  // expect-diagnostic: 99919 UNSUPPORTED_ASSIGNMENT
  each(movers, (e) => {
    for (e.Position.x of [5, 6]) {
      seen.push(e.Position.x);
    }
  });

  return { seen, xs: ids.map((id) => get(movers, id, Position.x)) };
}
