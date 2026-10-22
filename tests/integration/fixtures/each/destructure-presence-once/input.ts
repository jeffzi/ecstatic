// rewrite-applies: destructure-optional-slot
// rewrite-applies: destructure-default-plain
import {
  archetype,
  component,
  createWorld,
  disable,
  each,
  enable,
  get,
  ref,
  register,
  spawn,
} from "ecstatic";

const Base = component("LedgerBase", { x: 0 });
const Entry = component("LedgerEntry", { first: ref<number>(), second: ref<number>(), third: 0 });

/**
 * Destructures an optional slot whose first field's default disables it: the pattern tests the slot's presence once,
 * so the fields after that default still read its columns, as the record the runtime's slot getter returned does.
 *
 * @returns What the body bound, row by row, and the slot's second field after the loop.
 */
export function scenario(): unknown {
  const storage = register(createWorld(), archetype([Base], [Entry]));
  const id = spawn(storage, { LedgerBase: { x: 1 }, LedgerEntry: { second: 4, third: 6 } });
  const trace: unknown[] = [];

  each(storage, (e) => {
    const {
      first = (disable(storage, e.id, Entry), trace.push("disabled"), 1),
      second,
      third,
      // oxlint-disable-next-line typescript/no-non-null-assertion -- destructuring a non-null optional slot is the behavior under test
    } = e.LedgerEntry!;
    trace.push(first, second, third);
  });

  enable(storage, id, Entry);
  return { trace, second: get(storage, id, Entry.second) };
}
