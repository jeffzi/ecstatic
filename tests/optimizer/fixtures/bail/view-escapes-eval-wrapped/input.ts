import { createWorld, each, get, register, spawn } from "ecstatic";

import { Mover, Position } from "../../schema.js";

/**
 * Moves every row through direct eval calls whose callee is wrapped in a type assertion, which TypeScript erases,
 * so the eval still reaches the view.
 *
 * @returns Each row's x after both loops.
 */
export function scenario(): unknown {
  const world = createWorld();
  const movers = register(world, Mover);
  const ids = [
    spawn(movers, { Position: { x: 1, y: 0 } }),
    spawn(movers, { Position: { x: 2, y: 0 } }),
  ];

  // expect-diagnostic: 99918 VIEW_ESCAPES
  each(movers, (e) => {
    e.Position.y = 0;
    // oxlint-disable-next-line no-eval -- a direct eval through `as` is the behavior under test: the optimizer keeps the runtime call
    (eval as (source: string) => unknown)("e.Position.x *= 10");
  });
  // expect-diagnostic: 99918 VIEW_ESCAPES
  each(movers, (e) => {
    e.Position.y = 0;
    // oxlint-disable-next-line no-eval -- a direct eval through `satisfies` is the behavior under test: the optimizer keeps the runtime call
    (eval satisfies (source: string) => unknown)("e.Position.x -= 1");
  });

  return { xs: ids.map((id) => get(movers, id, Position.x)) };
}
