import { archetype, createWorld, each, register, spawn } from "ecstatic";

import { Position, Velocity } from "../../schema.js";

/** Visits a storage whose archetype spreads an array into its component list, which types a rest element. */
export function scenario(): unknown {
  const extras: (typeof Velocity)[] = [Velocity];
  const movers = register(createWorld(), archetype([Position, ...extras]));
  spawn(movers);
  spawn(movers);
  const visited: number[] = [];

  // expect-diagnostic: 99910 SHAPE_UNRESOLVED
  each(movers, (e) => {
    visited.push(e.id);
  });

  return { visited };
}
