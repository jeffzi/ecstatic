import { createWorld, each, get, register, spawn } from "ecstatic";

import { Mover, Position } from "../../schema.js";

/** Moves every row with an async callback, whose synchronous part runs during the pass. */
export function scenario(): unknown {
  const world = createWorld();
  const movers = register(world, Mover);
  const ids = [
    spawn(movers, { Position: { x: 1, y: 0 } }),
    spawn(movers, { Position: { x: 2, y: 0 } }),
  ];
  const visited: number[] = [];

  // expect-diagnostic: warning 99915 CALLBACK_ASYNC
  each(
    movers,
    // oxlint-disable-next-line typescript/no-misused-promises -- the async callback is the behavior under test: the optimizer leaves it a runtime call and warns
    async (e) => {
      visited.push(e.id);
      e.Position.x += 10;
      await Promise.resolve();
    },
  );

  return { visited, xs: ids.map((id) => get(movers, id, Position.x)) };
}
