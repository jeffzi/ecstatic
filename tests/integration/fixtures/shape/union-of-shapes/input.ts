import { createWorld, each, register, spawn } from "ecstatic";

import { Mover, Statue } from "../../schema.js";

/** Visits, one after the other, two storages of different shapes through one binding typed as their union. */
export function scenario(): unknown {
  const world = createWorld();
  const movers = register(world, Mover);
  const statues = register(world, Statue);
  spawn(movers, { Position: { x: 1, y: 0 } });
  spawn(statues, { Position: { x: 5, y: 0 }, Health: { hp: 3 } });
  const visited: number[] = [];
  const xs: number[] = [];

  for (const storage of [movers, statues]) {
    // expect-diagnostic: 99910 SHAPE_UNRESOLVED 5
    each(storage, (e) => {
      visited.push(e.id);
      xs.push(e.Position.x);
    });
  }

  return { visited, xs };
}
