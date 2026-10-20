import { archetype, component, createWorld, each, register, spawn } from "ecstatic";

import { Position } from "../../schema.js";

const Pennant = component("Pennant", { color: "" });
const Mast = archetype([Position], [Pennant]);

/** Reads every row's pennant color through `&&`, whose value is the slot itself on a row without a pennant. */
export function scenario(): unknown {
  const world = createWorld();
  const masts = register(world, Mast);
  spawn(masts, { Position: { x: 1, y: 0 }, Pennant: { color: "red" } });
  spawn(masts, { Position: { x: 2, y: 0 } });
  const colors: unknown[] = [];

  // expect-diagnostic: 99918 VIEW_ESCAPES
  each(masts, (e) => {
    // oxlint-disable-next-line typescript/prefer-optional-chain, typescript/strict-boolean-expressions -- the slot as the value of `&&` is the escape under test
    const color = e.Pennant && e.Pennant.color;
    colors.push(color);
  });

  return { colors };
}
