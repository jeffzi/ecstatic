// rewrite-applies: mode-hoisted
// rewrite-applies: read-required-field
// rewrite-applies: write-required-field
import { archetype, component, createWorld, each, get, register, spawn } from "ecstatic";

const Cell = component("Grid,Cell", { n: 0 });
const Mark = component("GridMark", { x: 0 });

/**
 * Moves every row of a storage holding a component whose name is no identifier, `"Grid,Cell"`, which the shape
 * guard keys as one component and the body reaches by its string key.
 *
 * @returns Each row's fields after the loop.
 */
export function scenario(): unknown {
  const storage = register(createWorld(), archetype([Cell, Mark]));
  const ids = [
    spawn(storage, { "Grid,Cell": { n: 1 }, GridMark: { x: 2 } }),
    spawn(storage, { "Grid,Cell": { n: 3 }, GridMark: { x: 4 } }),
  ];

  each(storage, (e) => {
    e.GridMark.x = e.GridMark.x * 10 + e["Grid,Cell"].n;
    e["Grid,Cell"].n += e.GridMark.x;
  });

  return ids.map((id) => [get(storage, id, Cell.n), get(storage, id, Mark.x)]);
}
