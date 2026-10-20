import { createWorld, each, register, spawn } from "ecstatic";

import { Mover } from "../../schema.js";

/** Copies every row's position with a rest pattern, which sees none of the record's accessors. */
export function scenario(): unknown {
  const world = createWorld();
  const movers = register(world, Mover);
  spawn(movers, { Position: { x: 1, y: 0 } });
  spawn(movers, { Position: { x: 2, y: 0 } });
  const keyCounts: number[] = [];

  // expect-diagnostic: 99918 VIEW_ESCAPES
  each(movers, (e) => {
    const { ...copy } = e.Position;
    keyCounts.push(Object.keys(copy).length);
  });

  return { keyCounts };
}
