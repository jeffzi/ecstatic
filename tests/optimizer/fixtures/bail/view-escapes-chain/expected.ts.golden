import { archetype, component, createWorld, each, register, spawn } from "ecstatic";

import { Position } from "../../schema.js";

const Crest = component("Crest", { motto: "" });
const Knight = archetype([Position], [Crest]);

/** Reads the length of every row's crest motto through an optional chain that continues past the field. */
export function scenario(): unknown {
  const world = createWorld();
  const knights = register(world, Knight);
  spawn(knights, { Position: { x: 1, y: 0 }, Crest: { motto: "onward" } });
  spawn(knights, { Position: { x: 2, y: 0 } });
  const lengths: number[] = [];

  // expect-diagnostic: 99918 VIEW_ESCAPES
  each(knights, (e) => {
    lengths.push(e.Crest?.motto.length ?? -1);
  });

  return { lengths };
}
