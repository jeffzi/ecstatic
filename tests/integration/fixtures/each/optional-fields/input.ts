// rewrite-applies: mode-realloc-safe
// rewrite-applies: read-optional-field
// rewrite-applies: write-optional-field
// rewrite-applies: update-field
// rewrite-applies: non-null-slot
// rewrite-applies: presence-optional
import {
  archetype,
  component,
  createWorld,
  disable,
  each,
  enable,
  get,
  register,
  spawn,
  u8,
} from "ecstatic";

const Hull = component("WardHull", { x: 0 });
const Ward = component("WardShield", { hp: 0, level: u8(0) });

/** The constructor name of `error`, or its type when it is no `Error`. */
function nameOf(error: unknown): string {
  return error instanceof Error ? error.constructor.name : typeof error;
}

/**
 * Reads, writes, and updates the fields of an optional component, a `u8()` one included, then disables it and
 * reads and writes them again, on a row where it is enabled and on one where it is not.
 *
 * @returns What the body read, with the constructor name of each error a field access threw, and the warded row's
 * fields after the loop.
 */
export function scenario(): unknown {
  const storage = register(createWorld(), archetype([Hull], [Ward]));
  const warded = spawn(storage, { WardHull: { x: 1 }, WardShield: { hp: 5, level: 250 } });
  spawn(storage, { WardHull: { x: 2 } });
  const trace: unknown[] = [];

  // fallow-ignore-next-line complexity -- the callback packs the forms under test into one body
  each(storage, (e) => {
    // oxlint-disable-next-line typescript/strict-boolean-expressions -- testing an optional slot is the lowering under test
    if (e.WardShield) {
      e.WardShield.hp -= 1;
      e.WardShield.hp ||= 3;
      e.WardShield.hp &&= e.WardShield.hp * 2;
      e.WardShield.level += 10;
      trace.push(e.WardShield.hp++, --e.WardShield.level, e.WardShield.hp, e.WardShield.level);
      disable(storage, e.id, Ward);
    }
    try {
      // oxlint-disable-next-line typescript/no-non-null-assertion -- a non-null slot of a disabled optional is the read under test
      trace.push(e.WardShield!.hp);
    } catch (error) {
      trace.push("read", nameOf(error));
    }
    try {
      // oxlint-disable-next-line typescript/no-non-null-assertion -- a non-null slot of a disabled optional is the write under test
      e.WardShield!.hp = 9;
    } catch (error) {
      trace.push("write", nameOf(error));
    }
    try {
      // oxlint-disable-next-line typescript/no-non-null-assertion -- a non-null slot of a disabled optional is the update under test
      e.WardShield!.level++;
    } catch (error) {
      trace.push("update", nameOf(error));
    }
  });

  enable(storage, warded, Ward);
  return { trace, hp: get(storage, warded, Ward.hp), level: get(storage, warded, Ward.level) };
}
