import { createWorld, each, register, spawn } from "ecstatic";

import { Mover } from "../../schema.js";

/** Assigns the view's getter-only id, which throws in strict code. */
export function scenario(): unknown {
  const world = createWorld();
  const movers = register(world, Mover);
  spawn(movers, { Position: { x: 1, y: 0 } });
  let thrown = "none";

  try {
    // expect-diagnostic: 99918 VIEW_ESCAPES
    each(movers, (e) => {
      // @ts-expect-error -- assigning the read-only id is the behavior under test
      e.id = 0;
    });
  } catch (error) {
    thrown = error instanceof Error ? error.constructor.name : typeof error;
  }

  return { thrown };
}
