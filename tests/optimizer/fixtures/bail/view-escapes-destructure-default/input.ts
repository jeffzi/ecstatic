import { archetype, component, createWorld, each, register, spawn } from "ecstatic";

import { Position } from "../../schema.js";

const Ward = component("Ward", { level: 0 });
const Warded = archetype([Position], [Ward]);

/** Reads every row's ward level through a pattern that gives the ward slot a default for rows without one. */
export function scenario(): unknown {
  const world = createWorld();
  const warded = register(world, Warded);
  spawn(warded, { Position: { x: 1, y: 0 }, Ward: { level: 3 } });
  spawn(warded, { Position: { x: 2, y: 0 } });
  const fallback = { level: -1 };
  const levels: number[] = [];

  // expect-diagnostic: 99918 VIEW_ESCAPES 3 `line 19, column 13: a destructuring form that does not lower`
  each(warded, (e) => {
    const { Ward: { level } = fallback } = e;
    levels.push(level);
  });

  return { levels };
}
