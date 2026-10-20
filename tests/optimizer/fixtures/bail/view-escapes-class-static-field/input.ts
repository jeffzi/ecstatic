import { createWorld, each, register, spawn } from "ecstatic";

import { Mover } from "../../schema.js";

/** Holds the id of every row in a static field of a class declared in the body, initialized from the view. */
export function scenario(): unknown {
  const world = createWorld();
  const movers = register(world, Mover);
  spawn(movers, { Position: { x: 1, y: 0 } });
  spawn(movers, { Position: { x: 2, y: 0 } });
  const held: number[] = [];
  const idOf = (view: { readonly id: number }): number => view.id;

  // expect-diagnostic: 99918 VIEW_ESCAPES
  each(movers, (e) => {
    class Probe {
      static readonly id = idOf(e);
      readonly label = "probe";
    }
    held.push(Probe.id, new Probe().label.length);
  });

  return { held };
}
