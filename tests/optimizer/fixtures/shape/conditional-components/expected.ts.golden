import { archetype, createWorld, each, register, spawn, type Storage } from "ecstatic";

import { Position, Velocity } from "../../schema.js";

/** The component tuple of a mover, which only a caller's `Flying` reduces to a tuple. */
type MoverParts<Flying extends boolean> = Flying extends true
  ? readonly [typeof Position, typeof Velocity]
  : readonly [typeof Position];

function visitAll<Flying extends boolean>(parts: MoverParts<Flying>, visited: number[]): void {
  const storage = register(createWorld(), archetype(parts));
  // spawn cannot check its overrides against an unreduced component tuple, so it spawns through the wide type.
  const wide: Storage = storage;
  spawn(wide);
  spawn(wide);

  // expect-diagnostic: 99910 SHAPE_UNRESOLVED
  each(storage, (e) => {
    visited.push(e.id);
  });
}

/** Visits a storage whose component tuple is a conditional type left unreduced inside a generic function. */
export function scenario(): unknown {
  const visited: number[] = [];

  visitAll<true>([Position, Velocity], visited);

  return { visited };
}
