import { createWorld, each, register, spawn } from "ecstatic";

import { Mover } from "../../schema.js";

/** Collects the id of every row from a static block of a class declared in the body, which hands on the view. */
export function scenario(): unknown {
  const world = createWorld();
  const movers = register(world, Mover);
  spawn(movers, { Position: { x: 1, y: 0 } });
  spawn(movers, { Position: { x: 2, y: 0 } });
  const visited: number[] = [];
  const names: string[] = [];
  const record = (view: { readonly id: number }): void => {
    visited.push(view.id);
  };

  // expect-diagnostic: 99918 VIEW_ESCAPES
  each(movers, (e) => {
    class Probe {
      static {
        record(e);
      }
    }
    names.push(Probe.name);
  });

  return { visited, names };
}
