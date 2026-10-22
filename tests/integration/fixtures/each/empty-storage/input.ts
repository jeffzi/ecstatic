// rewrite-applies: callback-without-parameter
import { archetype, component, createWorld, each, register, spawn } from "ecstatic";

const Crate = component("DockCrate", { x: 0 });

/**
 * Counts rows with a callback that takes no parameter, over an empty storage, which runs no row, then over a
 * storage of two rows.
 *
 * @returns How many rows each walk ran.
 */
export function scenario(): unknown {
  const empty = register(createWorld(), archetype([Crate]));
  const full = register(createWorld(), archetype([Crate]));
  spawn(full, { DockCrate: { x: 1 } });
  spawn(full, { DockCrate: { x: 2 } });
  let emptyRows = 0;
  let fullRows = 0;

  each(empty, () => {
    emptyRows += 1;
  });
  each(full, () => {
    fullRows += 1;
  });

  return { emptyRows, fullRows };
}
