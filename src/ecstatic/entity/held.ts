/**
 * Values read from a caller's records before the write that stores them.
 *
 * A write that takes a values or overrides record reads every value from it
 * here first, and only then resolves the dense row it writes, with no user
 * code in between. A getter on the record may spawn into the storage, growing
 * it and replacing its column arrays, or despawn an entity, moving another one
 * into a different dense row; a row resolved before the getter ran would then
 * receive the write in the wrong place.
 *
 * Each read value is held next to its field's `FieldColumn`. Growth swaps the
 * new array into the same `FieldColumn`, so a held column still names the live
 * array when the write runs, and the write is one flat pass over the frame.
 *
 * A stack: a getter that writes while its caller's values are being read
 * holds its own above them and releases back to where it started, so the
 * caller's held values are never overwritten. Reused across calls, so a write
 * allocates nothing once the stack has reached its deepest nesting.
 */

import type { ComponentDescriptor } from "../component.js";
import type { FieldColumn, Storage } from "../world.js";

const held: unknown[] = [];
let top = 0;

/**
 * The first free slot of the held stack.
 *
 * @returns The slot the next hold writes; capture it before holding a frame, then pass it to
 *   {@link writeHeldFields} and {@link releaseHeld}.
 */
export function heldTop(): number {
  return top;
}

/**
 * Push one value onto the held stack.
 *
 * @param value - The value to hold, already read from the caller's record.
 */
export function hold(value: unknown): void {
  held[top] = value;
  top += 1;
}

/**
 * Read one held value.
 *
 * @param slot - A slot below {@link heldTop}.
 * @returns The value held in `slot`.
 */
export function heldValue(slot: number): unknown {
  return held[slot];
}

/**
 * Read a component's field values from a caller's record onto the held stack: each declared
 * field once, in column order, holding its column and its value when the value is not
 * `undefined`. A tag has no columns and holds nothing.
 *
 * @param storage - Storage whose `fieldColumns` name the component's columns.
 * @param comp - Component whose declared fields are read.
 * @param values - The caller's record; a field it leaves absent or `undefined` holds nothing, so
 *   its column keeps what it has.
 * @throws Whatever a getter on `values` throws; the caller releases its frame
 */
export function holdFieldValues(
  storage: Storage,
  comp: ComponentDescriptor,
  values: Record<string, unknown>,
): void {
  const columns = storage.fieldColumns.get(comp);
  if (columns === undefined) {
    return;
  }
  const fields = comp.__ecstatic_fields;
  for (let i = 0; i < fields.length; i++) {
    // oxlint-disable-next-line typescript/no-non-null-assertion -- i < fields.length
    const value = values[fields[i]!];
    if (value !== undefined) {
      held[top] = columns[i];
      held[top + 1] = value;
      top += 2;
    }
  }
}

/**
 * Hold a required component's birth values: each declared field's value from the record when
 * it is not `undefined`, else its declared default, with its column. A ref field with neither
 * holds nothing, keeping the slot despawn cleared. A tag has no columns and holds nothing.
 *
 * @param storage - Storage whose `fieldColumns` name the component's columns.
 * @param comp - Required component whose fields are held.
 * @param record - The component's override record, each declared field read once, or
 *   `undefined` to hold the defaults.
 * @throws Whatever a getter on `record` throws; the caller releases its frame
 */
export function holdBirthValues(
  storage: Storage,
  comp: ComponentDescriptor,
  record: Record<string, unknown> | undefined,
): void {
  const columns = storage.fieldColumns.get(comp);
  if (columns === undefined) {
    return;
  }
  const fields = comp.__ecstatic_fields;
  const defaultValues = comp.__ecstatic_default_values;
  const isRef = comp.__ecstatic_is_reference;
  for (let i = 0; i < fields.length; i++) {
    // oxlint-disable-next-line typescript/no-non-null-assertion -- i < fields.length
    let value = record?.[fields[i]!];
    if (value === undefined) {
      if (isRef[i] === true) {
        continue;
      }
      value = defaultValues[i];
    }
    held[top] = columns[i];
    held[top + 1] = value;
    top += 2;
  }
}

/**
 * Write the column and value pairs held from `start` to `end` into a run of consecutive rows.
 * Runs no user code.
 *
 * @param start - First held slot of the pairs.
 * @param end - Slot after the last pair.
 * @param row - First dense row written.
 * @param count - Number of consecutive rows written, each with the same values.
 */
export function writeHeldFields(start: number, end: number, row: number, count: number): void {
  for (let slot = start; slot < end; slot += 2) {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- holdFieldValues holds a FieldColumn in every even slot of a pair
    const column = held[slot] as FieldColumn;
    fillRows(column.array, row, count, held[slot + 1]);
  }
}

/**
 * Release every slot from `base` up, so the stack does not keep a caller's
 * values alive between calls.
 *
 * @param base - The {@link heldTop} captured before the frame was held.
 */
export function releaseHeld(base: number): void {
  for (let slot = base; slot < top; slot++) {
    held[slot] = undefined;
  }
  top = base;
}

function fillRows(col: { [i: number]: unknown }, row: number, count: number, value: unknown): void {
  for (let i = 0; i < count; i++) {
    col[row + i] = value;
  }
}
