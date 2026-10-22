// rewrite-applies: callback-function
// rewrite-applies: return-void
import { archetype, component, createWorld, each, get, register, spawn } from "ecstatic";

const Coil = component("SpringCoil", { x: 0 });

/**
 * Moves every row through a function-expression callback that neither reads `this` nor `arguments`.
 *
 * @returns Each row's `x` after the loop.
 */
export function scenario(): unknown {
  const storage = register(createWorld(), archetype([Coil]));
  const ids = [spawn(storage, { SpringCoil: { x: 1 } }), spawn(storage, { SpringCoil: { x: 2 } })];

  each(storage, function (e) {
    if (e.SpringCoil.x === 1) return;
    e.SpringCoil.x *= 7;
  });

  return ids.map((id) => get(storage, id, Coil.x));
}
