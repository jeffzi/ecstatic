/**
 * Field writes from a caller's values record, whose getters may run user code
 * between two writes.
 *
 * A getter may spawn into the storage, growing it and replacing its column
 * arrays, or despawn an entity, moving another one into a different dense row.
 * Each write here takes its column from the field's `FieldColumn`, which growth
 * updates in place, and resolves the entity's row after the value is read, so
 * no write lands in a dropped array or a row the entity has left.
 */

import type { ComponentDescriptor } from "../component.js";
import { DEBUG } from "../debug.js";
import type { EntityId } from "../entity-id.js";
import { entityIndex } from "../entity-id.js";
import { ERROR_STALE_ENTITY_ID } from "../errors.js";
import type { FieldColumn, Storage } from "../world.js";

/**
 * Write a component's field values into an entity's row, each declared field read exactly once.
 * The row is resolved again after every read.
 *
 * @param storage - Storage the entity lives in.
 * @param id - The entity written; under DEBUG it is checked alive after every read.
 * @param columns - The component's field columns, from `storage.fieldColumns`.
 * @param values - Fields to patch, stored by reference (no clone); a field absent from the
 *   record or set to `undefined` keeps its current slot value.
 * @throws If DEBUG and a getter on `values` despawned the entity; the fields before it are
 *   already written
 * @throws Whatever a getter on `values` throws; the fields before it are already written
 */
export function writeColumnValues(
  storage: Storage,
  id: EntityId,
  columns: readonly FieldColumn[],
  values: Record<string, unknown>,
): void {
  const index = entityIndex(id);
  for (let i = 0; i < columns.length; i++) {
    // oxlint-disable-next-line typescript/no-non-null-assertion -- i < columns.length
    const column = columns[i]!;
    const value = values[column.field];
    if (DEBUG && storage.generation[index] !== id) {
      throw new Error(ERROR_STALE_ENTITY_ID);
    }
    if (value !== undefined) {
      // oxlint-disable-next-line typescript/no-non-null-assertion -- the entity is alive, so its sparse slot is populated
      writeSlot(column.array, storage.sparse[index]!, value);
    }
  }
}

/**
 * Write a component's field values into an entity's row; see {@link writeColumnValues}. A tag
 * has no columns, so its values are never read.
 *
 * @param storage - Storage the entity lives in.
 * @param id - The entity written.
 * @param comp - Component whose fields are written.
 * @param values - Fields to patch, each declared field read once.
 * @throws If DEBUG and a getter on `values` despawned the entity
 * @throws Whatever a getter on `values` throws; the fields before it are already written
 */
export function writeFieldOverrides(
  storage: Storage,
  id: EntityId,
  comp: ComponentDescriptor,
  values: Record<string, unknown>,
): void {
  const columns = storage.fieldColumns.get(comp);
  if (columns !== undefined) {
    writeColumnValues(storage, id, columns, values);
  }
}

/**
 * Write one row's field values, each declared field read exactly once, into the row index
 * given rather than an entity's row.
 *
 * @param columns - The component's field columns.
 * @param values - Fields to patch; absent or `undefined` fields keep their slot.
 * @param di - Dense row written.
 * @throws Whatever a getter on `values` throws; the fields before it are already written
 */
export function writeRowValues(
  columns: readonly FieldColumn[],
  values: Record<string, unknown>,
  di: number,
): void {
  for (let i = 0; i < columns.length; i++) {
    // oxlint-disable-next-line typescript/no-non-null-assertion -- i < columns.length
    const column = columns[i]!;
    const value = values[column.field];
    if (value !== undefined) {
      writeSlot(column.array, di, value);
    }
  }
}

function writeSlot(col: { [i: number]: unknown }, row: number, value: unknown): void {
  col[row] = value;
}
