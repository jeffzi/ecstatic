/**
 * Field access: read and write individual component fields on entities.
 */

import type { ComponentDescriptor, ComponentFields, FieldDescriptor } from "../component.js";
import { isFieldDescriptor } from "../component.js";
import type { EntityId } from "../entity-id.js";
import { entityIndex } from "../entity-id.js";
import type { Storage, TypedArray, World } from "../world.js";
import { resolveEntityArch } from "./common.js";

/**
 * Resolve the column backing a component field on a storage.
 *
 * @throws If the component is not on the storage's archetype
 * @throws If the component has no data fields (tag component)
 * @throws If the field name is unknown on the component
 */
function resolveFieldColumn(
  storage: Storage,
  comp: ComponentDescriptor,
  fieldName: string,
): TypedArray | Array<unknown> {
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
 * Read a field through either a storage or world handle, resolving the
 * owning archetype internally.
 *
 * @param storageOrWorld - The storage or world containing the entity
 * @param id - The entity ID
 * @param field - The field descriptor (e.g., Position.x)
 * @returns The current field value
 * @throws If the entity ID is stale or from another storage (under DEBUG)
 * @throws If the component or field cannot be resolved on the archetype
 */
export function get<V>(storageOrWorld: Storage | World, id: EntityId, field: FieldDescriptor<V>): V;
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

export function set<V>(
  storageOrWorld: Storage | World,
  id: EntityId,
  field: FieldDescriptor<V>,
  // NoInfer: the field descriptor alone fixes V, so a mismatched value is an
  // error instead of widening V (e.g. `undefined` must not widen number fields)
  value: NoInfer<V>,
): void;
export function set<C extends ComponentDescriptor>(
  storageOrWorld: Storage | World,
  id: EntityId,
  comp: C,
  values: Partial<ComponentFields<C>>,
): void;
/**
 * Write one field via a descriptor or multiple fields via a partial
 * component record.
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

  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the overload signatures guarantee valuesOrValue is a Record<string, unknown> here
  const values = valuesOrValue as Record<string, unknown>;
  for (const [fieldName, value] of Object.entries(values)) {
    writeField(storage, di, componentOrField, fieldName, value);
  }
}
