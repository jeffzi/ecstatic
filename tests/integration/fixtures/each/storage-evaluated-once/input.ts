// rewrite-applies: callback-without-parameter
import { archetype, component, createWorld, each, register, spawn } from "ecstatic";

const Bale = component("BarnBale", { x: 0 });
const Barn = archetype([Bale]);

/**
 * Evaluates the storage argument once, before any row: an identifier the body reassigns keeps its first storage
 * for the whole loop, and a call is made once.
 *
 * @returns How many rows ran over the reassigned identifier, and how often the storage call and the body ran.
 */
export function scenario(): unknown {
  const first = register(createWorld(), Barn);
  const second = register(createWorld(), Barn);
  spawn(first, { BarnBale: { x: 1 } });
  spawn(first, { BarnBale: { x: 2 } });
  for (const x of [3, 4, 5]) {
    spawn(second, { BarnBale: { x } });
  }
  let current = first;
  let rows = 0;
  let calls = 0;
  const pick = (): typeof first => {
    calls += 1;
    return first;
  };

  each(current, () => {
    current = second;
    rows += 1;
  });
  each(pick(), () => {
    calls += 10;
  });

  return { rows, calls };
}
