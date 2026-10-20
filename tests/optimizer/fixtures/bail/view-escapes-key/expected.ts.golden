import { createWorld, each, register, spawn } from "ecstatic";

import { Mover } from "../../schema.js";

/** Reads a key every slot record inherits but no component declares. */
export function scenario(): unknown {
  const world = createWorld();
  const movers = register(world, Mover);
  spawn(movers, { Position: { x: 1, y: 0 } });
  spawn(movers, { Position: { x: 2, y: 0 } });
  const names: string[] = [];

  // expect-diagnostic: 99918 VIEW_ESCAPES
  each(movers, (e) => {
    names.push(e.Position.constructor.name);
  });

  return { names };
}
