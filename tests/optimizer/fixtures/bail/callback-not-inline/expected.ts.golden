import { createWorld, each, register, spawn } from "ecstatic";

import { Mover } from "../../schema.js";

/** Visits a storage with a callback declared before the call. */
export function scenario(): unknown {
  const world = createWorld();
  const movers = register(world, Mover);
  spawn(movers, { Position: { x: 1, y: 0 } });
  spawn(movers, { Position: { x: 2, y: 0 } });
  const visited: number[] = [];
  const visit = (e: { readonly id: number }): void => {
    visited.push(e.id);
  };

  // expect-diagnostic: 99913 CALLBACK_NOT_INLINE
  each(movers, visit);

  return { visited };
}
