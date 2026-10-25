import { archetype, createWorld, each, register, spawn } from "ecstatic";

import { Health, Position } from "../../schema.js";

/** The component a placed entity carries, typed as the union of both so no narrowing picks one. */
function placement(armored: boolean): typeof Position | typeof Health {
  return armored ? Health : Position;
}

/** Visits a storage whose one component is typed as a union of two components. */
export function scenario(): unknown {
  const picked = register(createWorld(), archetype([placement(false)]));
  spawn(picked);
  spawn(picked);
  const visited: number[] = [];

  // expect-diagnostic: 99910 SHAPE_UNRESOLVED 3
  each(picked, (e) => {
    visited.push(e.id);
  });

  return { visited };
}
