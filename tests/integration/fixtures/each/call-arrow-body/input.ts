// rewrite-applies: callback-arrow
// rewrite-applies: read-required-field
import { archetype, component, createWorld, each, register, spawn } from "ecstatic";

const Tail = component("KiteTail", { x: 0 });

/**
 * Runs an each call that is the expression body of an arrow function, so the loop runs on every call of the arrow.
 *
 * @returns The values each call recorded, in visit order, with a marker between the two calls.
 */
export function scenario(): unknown {
  const storage = register(createWorld(), archetype([Tail]));
  for (const x of [1, 2, 3]) {
    spawn(storage, { KiteTail: { x } });
  }
  const seen: unknown[] = [];

  const run = (): void =>
    // oxlint-disable-next-line typescript/no-confusing-void-expression -- the each call as an arrow's expression body is the behavior under test
    each(storage, (e) => {
      seen.push(e.KiteTail.x);
    });
  run();
  seen.push("again");
  run();

  return seen;
}
