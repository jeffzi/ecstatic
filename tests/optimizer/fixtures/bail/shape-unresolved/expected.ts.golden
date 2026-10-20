import { createWorld, each, register, spawn, type Storage } from "ecstatic";

import { Mover } from "../../schema.js";

/** Visits a storage whose type does not carry its archetype. */
export function scenario(): unknown {
  const world = createWorld();
  const movers = register(world, Mover);
  spawn(movers, { Position: { x: 1, y: 0 } });
  spawn(movers, { Position: { x: 2, y: 0 } });
  const untyped: Storage = movers;
  const visited: number[] = [];

  // expect-diagnostic: 99910 SHAPE_UNRESOLVED
  each(untyped, (e) => {
    visited.push(e.id);
  });

  return { visited };
}
