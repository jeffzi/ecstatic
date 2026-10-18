import { createWorld, each, register, spawn } from "ecstatic";

import { Mover, Statue } from "../../schema.js";

/** Visits storages passed as an array variable rather than an array literal. */
export function scenario(): unknown {
  const world = createWorld();
  const movers = register(world, Mover);
  const statues = register(world, Statue);
  spawn(movers, { Position: { x: 1, y: 0 } });
  spawn(statues, { Health: { hp: 5 } });
  const storages = [movers, statues];
  const visited: number[] = [];

  // expect-diagnostic: 99912 STORAGES_DYNAMIC
  each(storages, (e) => {
    visited.push(e.id);
  });

  return { visited };
}
