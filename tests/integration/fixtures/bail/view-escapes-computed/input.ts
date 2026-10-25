import { createWorld, each, get, register, spawn } from "ecstatic";

import { Mover, Position } from "../../schema.js";

/** Moves every row along each axis named in a list, reaching the fields by computed keys. */
export function scenario(): unknown {
  const world = createWorld();
  const movers = register(world, Mover);
  const ids = [
    spawn(movers, { Position: { x: 1, y: 2 } }),
    spawn(movers, { Position: { x: 3, y: 4 } }),
  ];
  const axes: readonly ("x" | "y")[] = ["x", "y"];

  // expect-diagnostic: 99918 VIEW_ESCAPES 3 `line 18, column 7: a computed access`
  each(movers, (e) => {
    for (const axis of axes) {
      e.Position[axis] += 10;
    }
  });

  return {
    xs: ids.map((id) => get(movers, id, Position.x)),
    ys: ids.map((id) => get(movers, id, Position.y)),
  };
}
