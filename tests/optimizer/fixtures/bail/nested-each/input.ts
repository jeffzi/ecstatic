import { createWorld, each, register, spawn } from "ecstatic";

import { Mover, Statue } from "../../schema.js";

/** Pairs every mover with every statue, each level bailing for its own reason. */
export function scenario(): unknown {
  const world = createWorld();
  const movers = register(world, Mover);
  const statues = register(world, Statue);
  spawn(movers, { Position: { x: 1, y: 0 } });
  spawn(movers, { Position: { x: 2, y: 0 } });
  spawn(statues, { Health: { hp: 4 } });
  spawn(statues, { Health: { hp: 6 } });
  const names: string[] = [];
  const pairs: number[][] = [];

  // expect-diagnostic: 99917 CALLBACK_FUNCTION_BINDINGS 3
  each(movers, function pair(outer) {
    names.push(pair.name);
    // expect-diagnostic: 99914 CALLBACK_PARAMS 5
    each(statues, (inner, weight = 2) => {
      pairs.push([outer.id, inner.id, inner.Health.hp * weight]);
    });
  });

  return { names, pairs };
}
