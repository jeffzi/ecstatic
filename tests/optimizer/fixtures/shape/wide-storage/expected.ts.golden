import { createWorld, each, register, spawn, type Storage } from "ecstatic";

import { Mover } from "../../schema.js";

function visitAll(storage: Storage, visited: number[]): void {
  // expect-diagnostic: 99910 SHAPE_UNRESOLVED
  each(storage, (e) => {
    visited.push(e.id);
  });
}

/** Visits a storage through a parameter whose `Storage` type keeps its default archetype argument. */
export function scenario(): unknown {
  const movers = register(createWorld(), Mover);
  spawn(movers, { Position: { x: 1, y: 0 } });
  spawn(movers, { Position: { x: 2, y: 0 } });
  const visited: number[] = [];

  visitAll(movers, visited);

  return { visited };
}
