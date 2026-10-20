import { createWorld, each, register, spawn } from "ecstatic";

import { Mover } from "../../schema.js";

/** Names a method of a class declared in the body after every row through a computed key that receives the view. */
export function scenario(): unknown {
  const world = createWorld();
  const movers = register(world, Mover);
  spawn(movers, { Position: { x: 1, y: 0 } });
  spawn(movers, { Position: { x: 2, y: 0 } });
  const methods: string[] = [];
  const keyOf = (view: { readonly id: number }): string => `row${String(view.id)}`;

  // expect-diagnostic: 99918 VIEW_ESCAPES
  each(movers, (e) => {
    class Probe {
      [keyOf(e)](): void {}
    }
    methods.push(...Object.getOwnPropertyNames(Probe.prototype));
  });

  return { methods };
}
