import { createWorld, each, register, spawn } from "ecstatic";

import { Mover } from "../../schema.js";

function visitAll<T>(storage: T, visited: number[]): T {
  // expect-diagnostic: 99910 SHAPE_UNRESOLVED
  each(
    // @ts-expect-error -- an argument typed by an unconstrained type parameter is the form under test
    storage,
    (e) => {
      visited.push(e.id);
    },
  );
  return storage;
}

/** Visits a storage through a function whose parameter type is an unconstrained type parameter. */
export function scenario(): unknown {
  const movers = register(createWorld(), Mover);
  spawn(movers, { Position: { x: 1, y: 0 } });
  spawn(movers, { Position: { x: 2, y: 0 } });
  const visited: number[] = [];

  const returned = visitAll(movers, visited);

  return { visited, sameStorage: returned === movers };
}
