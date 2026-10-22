// rewrite-applies: expression-body
import { archetype, component, createWorld, each, register, spawn } from "ecstatic";

const Bead = component("AbacusBead", { x: 0 });

/**
 * Runs an expression-bodied callback, whose expression runs once per row.
 *
 * @returns The values the expression recorded, in visit order.
 */
export function scenario(): unknown {
  const storage = register(createWorld(), archetype([Bead]));
  for (const x of [1, 2, 3]) {
    spawn(storage, { AbacusBead: { x } });
  }
  const seen: number[] = [];

  each(storage, (e) => seen.push(e.AbacusBead.x * 10));

  return seen;
}
