/**
 * Field access: read and write individual component fields on entities.
 */

import type { ComponentDescriptor, FieldDescriptor } from "../component.js";
import { isFieldDescriptor } from "../component.js";
import type { EntityId } from "../entity-id.js";
import { entityIndex } from "../entity-id.js";
import type { Storage, World } from "../world.js";
import { resolveEntityArch } from "./common.js";

/**
 * Resolve the column backing a component field on a storage.
 *
 * @throws If the component is not on the storage's archetype
 * @throws If the component has no data fields (tag component)
 * @throws If the field name is unknown on the component
 */
function resolveFieldColumn(storage: Storage, comp: ComponentDescriptor, fieldName: string) {
  const name = comp.__ecstatic_name;
  if (!storage.componentByName.has(name)) {
    throw new Error(`component ${name} not on this archetype`);
  }
  const soa = storage.columns.get(comp);
  if (soa === undefined) {
    throw new Error(`component ${name} has no data fields`);
  }
  const col = soa[fieldName];
  if (col === undefined) {
    throw new Error(`unknown field ${fieldName} on component ${name}`);
  }
  return col;
}

/**
 * Write one field value, encoding booleans as their 0/1 column representation
 * (boolean fields are stored in Uint8Array columns).
 */
function writeField(
  storage: Storage,
  di: number,
  comp: ComponentDescriptor,
  fieldName: string,
  value: unknown,
): void {
  const col = resolveFieldColumn(storage, comp, fieldName);
  if (typeof comp.__ecstatic_defaults[fieldName] === "boolean") {
    col[di] = value === true ? 1 : 0;
  } else {
    col[di] = value;
  }
}

/**
 * Get a single field value from an entity.
 *
 * Accepts either the entity's storage or its world; the world form resolves
 * the storage through the entity index.
 *
 * @param storageOrWorld - The storage or world containing the entity
 * @param id - The entity ID
 * @param field - The field descriptor (e.g., Position.x)
 * @returns The current field value
 * @throws If the entity ID is stale or from another storage (under DEBUG)
 * @throws If the component or field cannot be resolved on the archetype
 */
export function get(
  storageOrWorld: Storage | World,
  id: EntityId,
  field: FieldDescriptor,
): unknown {
  const storage = resolveEntityArch(storageOrWorld, id);
  const di = storage.sparse[entityIndex(id)]!;
  const comp = field.__ecstatic_component;
  const fieldName = field.__ecstatic_field;
  const value = resolveFieldColumn(storage, comp, fieldName)[di];

  // Boolean fields are stored as 0/1 in Uint8Array columns
  if (typeof comp.__ecstatic_defaults[fieldName] === "boolean") {
    return value !== 0;
  }
  return value;
}

export function set(
  storageOrWorld: Storage | World,
  id: EntityId,
  field: FieldDescriptor,
  value: unknown,
): void;
export function set(
  storageOrWorld: Storage | World,
  id: EntityId,
  comp: ComponentDescriptor,
  values: Record<string, unknown>,
): void;
/**
 * Set one or more fields on an entity.
 *
 * Two forms:
 * - `set(storageOrWorld, id, field, value)` — single field descriptor + value;
 *   `undefined` clears a ref field.
 * - `set(storageOrWorld, id, Component, { field: value, ... })` — partial
 *   values record; omitted fields keep their current values.
 *
 * @throws If the entity ID is stale or from another storage (under DEBUG)
 * @throws If the component or a field cannot be resolved on the archetype
 */
export function set(
  storageOrWorld: Storage | World,
  id: EntityId,
  componentOrField: ComponentDescriptor | FieldDescriptor,
  valuesOrValue?: unknown,
): void {
  const storage = resolveEntityArch(storageOrWorld, id);
  const di = storage.sparse[entityIndex(id)]!;

  if (isFieldDescriptor(componentOrField)) {
    writeField(
      storage,
      di,
      componentOrField.__ecstatic_component,
      componentOrField.__ecstatic_field,
      valuesOrValue,
    );
    return;
  }

  // The component-form overload guarantees a values record here
  const values = valuesOrValue as Record<string, unknown>;
  for (const [fieldName, value] of Object.entries(values)) {
    writeField(storage, di, componentOrField, fieldName, value);
  }
}
