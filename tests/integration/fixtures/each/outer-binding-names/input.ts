// rewrite-applies: outer-binding
import { archetype, component, createWorld, each, register, spawn } from "ecstatic";

const Rail = component("FenceRail", { x: 0 });

/**
 * Reads and writes bindings outside the callback that are named like the row count and the row index the inlined
 * loop declares, which keep pointing at the outer bindings.
 *
 * @returns What the body read on each row, and the outer index after the loop.
 */
export function scenario(): unknown {
  const storage = register(createWorld(), archetype([Rail]));
  for (const x of [1, 2, 3]) {
    spawn(storage, { FenceRail: { x } });
  }
  const n = 10;
  let i = 0;
  const seen: number[] = [];

  each(storage, (e) => {
    i += 1;
    seen.push(e.FenceRail.x * n + i);
  });

  return { seen, i };
}
