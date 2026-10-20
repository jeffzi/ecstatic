/**
 * Field access: read and write individual component fields on entities.
 */

import type { ComponentDescriptor, ComponentFields, FieldDescriptor } from "../component.js";
import { isFieldDescriptor } from "../component.js";
import { DEBUG } from "../debug.js";
import type { EntityId, With } from "../entity-id.js";
import { entityIndex } from "../entity-id.js";
import {
  ERROR_RELATION_NOT_ON_ARCHETYPE,
  ERROR_RELATION_TARGET_WRITE,
  errorNotEnabled,
} from "../errors.js";
import type {
  Relation,
  RelationConstraints,
  RelationFields,
  RelationTargetFieldDescriptor,
} from "../relation.js";
import { getRelationMeta } from "../relation.js";
import type { Storage, TypedArray, World } from "../world.js";
import { resolveEntityArch } from "./common.js";

/**
 * Values record accepted by the record form of `set`.
 *
 * A relation's reserved `target` key is typed as the error sentence, so a
 * write fails to compile — the target column is owned by `link`/`unlink`.
 * Every other declared field stays settable, and a plain component keeps all
 * of its fields even when one is literally named `target`.
 */
type SettableFields<C> = C extends { readonly __ecstatic_relation_meta: unknown }
  ? Partial<RelationFields<C>> & { readonly target?: typeof ERROR_RELATION_TARGET_WRITE }
  : Partial<ComponentFields<C>>;

/**
 * Guard against writing the reserved `target` field of a relation — the
 * target column is owned by `link`/`unlink`.
 *
 * @param comp - Component being written; only a relation is guarded, so a
 *   plain component may freely own a field named `target`.
 * @param fieldOrValues - The field name in the field-descriptor form of
 *   `set`, or the values record in the record form; the record is only
 *   inspected for a `target` key, never written.
 * @throws If `comp` is a relation and the write names `target`.
 */
function guardRelationTargetWrite(
  comp: ComponentDescriptor,
  fieldOrValues: string | Record<string, unknown>,
): void {
  const isTarget =
    typeof fieldOrValues === "string" ? fieldOrValues === "target" : "target" in fieldOrValues;
  if (isTarget && getRelationMeta(comp) !== undefined) {
    throw new Error(ERROR_RELATION_TARGET_WRITE);
  }
}

/**
 * Resolve the column backing a component field on a storage.
 *
 * @param storage - Storage whose archetype and columns are consulted.
 * @param di - Dense row of the entity, used only for the DEBUG check that an
 *   optional component is enabled on that row.
 * @param comp - Component that owns the field; must carry data fields.
 * @param fieldName - Declared field name on `comp`.
 * @returns The column backing the field, indexed by dense row: a typed array
 *   for numeric and boolean fields, a plain array for reference fields. Column
 *   growth replaces it, so index it before the next spawn.
 * @throws If the component is not on the storage's archetype
 * @throws If DEBUG and the component is a disabled optional on this entity
 * @throws If the component has no data fields (tag component)
 * @throws If the field name is unknown on the component
 */
function resolveFieldColumn(
  storage: Storage,
  di: number,
  comp: ComponentDescriptor,
  fieldName: string,
): TypedArray | Array<unknown> {
  const name = comp.__ecstatic_name;
  if (!storage.componentByName.has(name)) {
    throw new Error(`component ${name} not on this archetype`);
  }
  // Disabled-optional access is a DEBUG-only guard: reading or writing a
  // field of an optional component that is not enabled on this entity reads
  // the pre-populated slot silently under NDEBUG, but errors here. Gated on
  // the optional-bit probe so required-component access pays one Map lookup
  // in DEBUG only.
  if (DEBUG) {
    const bit = storage.optionalBitLookup.get(comp);
    const maskVal = storage.mask[di];
    if (bit !== undefined && maskVal !== undefined && (maskVal & bit) === 0) {
      throw new Error(errorNotEnabled(name));
    }
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

interface RowCtx {
  storage: Storage;
  di: number;
}

/**
 * Write one field value into its column.
 *
 * @param row - The entity's storage and dense row index.
 * @param comp - Component that owns the field.
 * @param fieldName - Declared field name on `comp`.
 * @param value - New value, stored by reference; on a boolean field `true`
 *   is encoded as 1 and any other value as 0, matching the Uint8Array column.
 * @throws Whatever {@link resolveFieldColumn} throws when the component or
 *   field cannot be resolved on the archetype.
 */
function writeField(
  row: RowCtx,
  comp: ComponentDescriptor,
  fieldName: string,
  value: unknown,
): void {
  const col = resolveFieldColumn(row.storage, row.di, comp, fieldName);
  if (typeof comp.__ecstatic_defaults[fieldName] === "boolean") {
    col[row.di] = value === true ? 1 : 0;
  } else {
    col[row.di] = value;
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
  const di = storage.sparse[entityIndex(id)];
  /* istanbul ignore next */
  if (di === undefined) throw new Error("invariant: entity missing from sparse array");
  const comp = field.__ecstatic_component;
  const fieldName = field.__ecstatic_field;
  const value = resolveFieldColumn(storage, di, comp, fieldName)[di];

  // Boolean fields are stored as 0/1 in Uint8Array columns
  if (typeof comp.__ecstatic_defaults[fieldName] === "boolean") {
    return value !== 0;
  }
  return value;
}

/**
 * Write one field via a descriptor or multiple fields via a partial
 * component record.
 *
 * @param storageOrWorld - The entity's storage, or the world to resolve it
 *   from; the storage form additionally checks ownership under DEBUG.
 * @param id - Generational entity id, validated for staleness only under
 *   DEBUG.
 * @param field - Field descriptor to write (e.g. `Position.x`); in the record
 *   form, the component whose fields to patch.
 * @param value - New value, stored by reference; `undefined` clears a ref
 *   field. In the record form, a partial values record whose omitted fields
 *   keep their current values.
 * @throws If the entity ID is stale or from another storage (under DEBUG)
 * @throws If the component or a field cannot be resolved on the archetype
 */
export function set<V>(
  storageOrWorld: Storage | World,
  id: EntityId,
  // The target-brand exclusion knocks a relation's `target` descriptor out of
  // this overload so the sentence-error overload below catches it.
  field: FieldDescriptor<V> & { readonly __ecstatic_relation_target?: never },
  // NoInfer: the field descriptor alone fixes V, so a mismatched value is an
  // error instead of widening V (e.g. `undefined` must not widen number fields)
  value: NoInfer<V>,
): void;
export function set(
  storageOrWorld: Storage | World,
  id: EntityId,
  field: RelationTargetFieldDescriptor,
  value: "cannot write relation target field — use link() instead",
): void;
export function set<C extends ComponentDescriptor>(
  storageOrWorld: Storage | World,
  id: EntityId,
  comp: C,
  values: SettableFields<C>,
): void;
export function set(
  storageOrWorld: Storage | World,
  id: EntityId,
  componentOrField: ComponentDescriptor | FieldDescriptor,
  valuesOrValue?: unknown,
): void {
  const storage = resolveEntityArch(storageOrWorld, id);
  const di = storage.sparse[entityIndex(id)];
  /* istanbul ignore next */
  if (di === undefined) throw new Error("invariant: entity missing from sparse array");
  const row: RowCtx = { storage, di };

  if (isFieldDescriptor(componentOrField)) {
    guardRelationTargetWrite(
      componentOrField.__ecstatic_component,
      componentOrField.__ecstatic_field,
    );
    writeField(
      row,
      componentOrField.__ecstatic_component,
      componentOrField.__ecstatic_field,
      valuesOrValue,
    );
    return;
  }

  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the overload signatures guarantee valuesOrValue is a Record<string, unknown> here
  const values = valuesOrValue as Record<string, unknown>;
  guardRelationTargetWrite(componentOrField, values);
  for (const [fieldName, value] of Object.entries(values)) {
    writeField(row, componentOrField, fieldName, value);
  }
}

/**
 * Read the target of a relation on an entity in any archetype, resolving the
 * entity's archetype via world lookup.
 *
 * @param world - World that owns the entity; its generation table decides
 *   liveness, and that check is never stripped under NDEBUG.
 * @param id - Source entity id; a dead id yields `undefined`, not an error, up to the generation
 *   bound `alive` documents.
 * @param rel - Relation to read; must be on the entity's archetype.
 * @returns The live target's id, branded with the relation's constraints, or
 *   `undefined` when the source is dead, the relation is an optional that is
 *   disabled on this entity, the entity is unlinked (0 sentinel), or the
 *   target has since been despawned (stale generation).
 * @throws If the relation is not on the entity's archetype
 */
export function getTarget<R extends Relation>(
  world: World,
  id: EntityId,
  rel: R,
): With<RelationConstraints<R>> | undefined {
  const index = entityIndex(id);

  // Guard: source entity must be alive — a correctness result, not a debug
  // check, so it survives under NDEBUG.
  if (world.generation[index] !== id) {
    return undefined;
  }

  const storage = world.entityArch[index];
  if (storage === undefined) {
    return undefined;
  }

  const di = storage.sparse[index];
  /* istanbul ignore next */
  if (di === undefined) throw new Error("invariant: entity missing from sparse array");
  const soa = storage.columns.get(rel);
  const targetColumn = soa?.["target"];
  if (!(targetColumn instanceof Float64Array)) {
    throw new Error(ERROR_RELATION_NOT_ON_ARCHETYPE);
  }

  // Correctness guard: an optional relation that is disabled has no valid target.
  const bit = storage.optionalBitLookup.get(rel);
  const maskVal = storage.mask[di];
  if (bit !== undefined && maskVal !== undefined && (maskVal & bit) === 0) {
    return undefined;
  }

  // Sentinel 0 = not linked. This must precede the generation compare: a
  // zero-filled generation slot at index 0 would otherwise report the
  // sentinel as alive.
  const targetId = targetColumn[di];
  if (targetId === undefined || targetId === 0) {
    return undefined;
  }
  const targetIndex = entityIndex(targetId);
  if (world.generation[targetIndex] !== targetId) {
    return undefined;
  }

  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- branded type boundary: the column stores packed entity IDs
  return targetId as With<RelationConstraints<R>>;
}
