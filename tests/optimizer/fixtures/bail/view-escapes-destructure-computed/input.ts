import { createWorld, each, register, spawn } from "ecstatic";

import { Mover } from "../../schema.js";

/** Sums every row's position along each axis named in a list, reading the fields through computed pattern keys. */
export function scenario(): unknown {
  const world = createWorld();
  const movers = register(world, Mover);
  spawn(movers, { Position: { x: 1, y: 2 } });
  spawn(movers, { Position: { x: 3, y: 4 } });
  const axes: readonly ("x" | "y")[] = ["x", "y"];
  const sums: number[] = [];

  // expect-diagnostic: 99918 VIEW_ESCAPES
  each(movers, (e) => {
    let sum = 0;
    for (const axis of axes) {
      const { [axis]: value } = e.Position;
      sum += value;
    }
    sums.push(sum);
  });

  return { sums };
}
