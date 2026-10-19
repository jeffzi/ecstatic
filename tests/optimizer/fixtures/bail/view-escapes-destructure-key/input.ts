import { createWorld, each, register, spawn } from "ecstatic";

import { Mover } from "../../schema.js";

/** Reads, through a pattern key no component declares, the constructor every slot record inherits. */
export function scenario(): unknown {
  const world = createWorld();
  const movers = register(world, Mover);
  spawn(movers, { Position: { x: 1, y: 0 } });
  spawn(movers, { Position: { x: 2, y: 0 } });
  const names: string[] = [];

  // expect-diagnostic: 99918 VIEW_ESCAPES
  each(movers, (e) => {
    const { constructor: make } = e.Position;
    names.push(make.name);
  });

  return { names };
}
