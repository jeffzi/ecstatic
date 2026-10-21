import { archetype, component, createWorld, each, register, spawn } from "ecstatic";

import { Position } from "../../schema.js";

const Badge = component("Badge", { label: "" });
const Wearer = archetype([Position], [Badge]);

/** Reads every row's badge label, coalescing a missing badge slot to a fallback record. */
export function scenario(): unknown {
  const world = createWorld();
  const wearers = register(world, Wearer);
  spawn(wearers, { Position: { x: 1, y: 0 }, Badge: { label: "gold" } });
  spawn(wearers, { Position: { x: 2, y: 0 } });
  const labels: string[] = [];
  const fallback = { label: "none" };

  // expect-diagnostic: 99918 VIEW_ESCAPES 3 `line 19, column 19: a slot as a value`
  each(wearers, (e) => {
    const badge = e.Badge ?? fallback;
    labels.push(badge.label);
  });

  return { labels };
}
