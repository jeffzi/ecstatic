import { archetype, createWorld, each, register, spawn, type Storage } from "ecstatic";

import { Position, Velocity } from "../../schema.js";

// oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- a tuple spreading a type parameter is the form under test
function visitAll<Extra extends readonly (typeof Velocity)[]>(
  parts: readonly [typeof Position, ...Extra],
  visited: number[],
): void {
  const storage = register(createWorld(), archetype(parts));
  // spawn cannot check its overrides against an unreduced component tuple, so it spawns through the wide type.
  const wide: Storage = storage;
  spawn(wide);
  spawn(wide);

  // expect-diagnostic: 99910 SHAPE_UNRESOLVED 3
  each(storage, (e) => {
    visited.push(e.id);
  });
}

/** Visits a storage whose component tuple spreads a generic tuple, a variadic element left unreduced. */
export function scenario(): unknown {
  const visited: number[] = [];

  visitAll<readonly [typeof Velocity]>([Position, Velocity], visited);

  return { visited };
}
