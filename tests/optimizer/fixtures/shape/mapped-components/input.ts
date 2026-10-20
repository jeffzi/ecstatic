import { archetype, createWorld, each, register, spawn, type Storage } from "ecstatic";

import { Position, Velocity } from "../../schema.js";

/** The components of a mover, mapped element by element, which only a caller's `Parts` reduces to a tuple. */
type MoverParts<Parts extends readonly (typeof Position | typeof Velocity)[]> = {
  readonly [K in keyof Parts]: Parts[K];
};

function visitAll<Parts extends readonly (typeof Position | typeof Velocity)[]>(
  parts: MoverParts<Parts>,
  visited: number[],
): void {
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

/** Visits a storage whose component tuple is a mapped type left unreduced inside a generic function. */
export function scenario(): unknown {
  const visited: number[] = [];

  visitAll<readonly [typeof Position, typeof Velocity]>([Position, Velocity], visited);

  return { visited };
}
