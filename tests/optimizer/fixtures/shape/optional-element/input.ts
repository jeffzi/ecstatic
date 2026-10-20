import { archetype, createWorld, each, register, spawn, type Storage } from "ecstatic";

import { Position, Velocity } from "../../schema.js";

/** Visits a storage whose component tuple types its second element as optional. */
export function scenario(): unknown {
  const parts: readonly [typeof Position, typeof Velocity?] = [Position, Velocity];
  const movers = register(
    createWorld(),
    // @ts-expect-error -- an optional element widens the tuple's elements with undefined; it is the form under test
    archetype(parts),
  );
  // spawn cannot check its overrides against a tuple with an optional element, so it spawns through the wide type.
  const wide: Storage = movers;
  spawn(wide);
  spawn(wide);
  const visited: number[] = [];

  // expect-diagnostic: 99910 SHAPE_UNRESOLVED
  each(movers, (e) => {
    visited.push(e.id);
  });

  return { visited };
}
