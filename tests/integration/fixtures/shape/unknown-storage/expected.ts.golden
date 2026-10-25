import { createWorld, each, register, spawn } from "ecstatic";

import { Mover } from "../../schema.js";

/** Visits a storage held in a binding typed `unknown`. */
export function scenario(): unknown {
  const movers = register(createWorld(), Mover);
  spawn(movers, { Position: { x: 1, y: 0 } });
  spawn(movers, { Position: { x: 2, y: 0 } });
  const opaque: unknown = movers;
  const visited: number[] = [];

  // expect-diagnostic: 99910 SHAPE_UNRESOLVED 3
  each(
    // @ts-expect-error -- an unknown storage argument is the form under test
    opaque,
    (e) => {
      visited.push(e.id);
    },
  );

  return { visited };
}
