import { createWorld, each, register, spawn } from "ecstatic";

import { Mover } from "../../schema.js";

/** Visits a storage held in a binding typed `any`. */
export function scenario(): unknown {
  const movers = register(createWorld(), Mover);
  spawn(movers, { Position: { x: 1, y: 0 } });
  spawn(movers, { Position: { x: 2, y: 0 } });
  // oxlint-disable-next-line typescript/no-explicit-any -- an any-typed storage is the form under test
  const loose: any = movers;
  const visited: number[] = [];

  // expect-diagnostic: 99910 SHAPE_UNRESOLVED 3
  each(loose, (e) => {
    visited.push(e.id);
  });

  return { visited };
}
