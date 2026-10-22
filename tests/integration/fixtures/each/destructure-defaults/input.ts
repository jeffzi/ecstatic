// rewrite-applies: destructure-default-typed
// rewrite-applies: destructure-default-plain
import { archetype, component, createWorld, each, ref, register, spawn } from "ecstatic";

const Spot = component("MarginSpot", { x: 0 });
const Note = component("MarginNote", { first: ref<number>(), second: ref<number>() });

/**
 * Gives destructured fields defaults: a default on a typed-array column never applies, and one on a plain-array
 * column applies to `undefined`, each run in pattern order.
 *
 * @returns What the body bound and which defaults ran, row by row.
 */
export function scenario(): unknown {
  const storage = register(createWorld(), archetype([Spot], [Note]));
  spawn(storage, { MarginSpot: { x: 1 }, MarginNote: {} });
  spawn(storage, { MarginSpot: { x: 2 }, MarginNote: { first: 4 } });
  const trace: unknown[] = [];

  each(storage, (e) => {
    // oxlint-disable-next-line typescript/no-useless-default-assignment -- a default on a typed-array column is the lowering under test
    const { x = (trace.push("x default"), -1) } = e.MarginSpot;
    trace.push(x);
    // oxlint-disable-next-line typescript/strict-boolean-expressions -- testing an optional slot is the lowering under test
    if (e.MarginNote) {
      const {
        first = (trace.push("first default"), (e.MarginNote.second = 9), 1),
        second = (trace.push("second default"), 2),
      } = e.MarginNote;
      trace.push(first, second);
    }
  });

  return trace;
}
