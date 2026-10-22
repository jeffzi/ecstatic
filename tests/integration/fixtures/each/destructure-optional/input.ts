// rewrite-applies: destructure-optional-slot
import { archetype, component, createWorld, each, register, spawn, u8 } from "ecstatic";

const Hold = component("VaultHold", { x: 0 });
const Lock = component("VaultLock", { hp: 0, shut: false, level: u8(0) });

/** The constructor name of `error`, or its type when it is no `Error`. */
function nameOf(error: unknown): string {
  return error instanceof Error ? error.constructor.name : typeof error;
}

/**
 * Destructures an optional slot, renamed fields included, and with no field at all: on a row where it is enabled
 * the bindings read its columns, and on a row where it is disabled each declaration throws.
 *
 * @returns What the body bound, with the constructor name of each error a declaration threw, row by row.
 */
export function scenario(): unknown {
  const storage = register(createWorld(), archetype([Hold], [Lock]));
  spawn(storage, { VaultHold: { x: 1 }, VaultLock: { hp: 5, shut: true, level: 2 } });
  spawn(storage, { VaultHold: { x: 2 } });
  const trace: unknown[] = [];

  each(storage, (e) => {
    try {
      // oxlint-disable-next-line typescript/no-non-null-assertion -- destructuring a non-null optional slot is the behavior under test
      const { hp, shut, level: lv } = e.VaultLock!;
      trace.push(hp, shut, lv);
    } catch (error) {
      trace.push("fields", nameOf(error));
    }
    try {
      // oxlint-disable-next-line no-empty-pattern, typescript/no-non-null-assertion -- an empty pattern still tests the slot, the behavior under test
      const {} = e.VaultLock!;
      trace.push("empty");
    } catch (error) {
      trace.push("empty", nameOf(error));
    }
  });

  return trace;
}
