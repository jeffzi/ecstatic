/**
 * Entity spawning: allocate entity IDs, initialize component fields.
 */

import type { EntityId } from "../entity-id.js";
import { assertEntityIndex, initialEntityId } from "../entity-id.js";
import type { Storage, TypedArray, WorldState } from "../world.js";

/**
 * Per-component spawn overrides, keyed by component name.
 *
 * A record value overrides individual fields (omitted fields take defaults).
 * `true` means "use defaults"; `false` on a required component is an error.
 */
export type SpawnOverrides = Record<string, Record<string, unknown> | boolean>;

/**
 * Spawn an entity with optional component field overrides.
 *
 * Allocates a fresh or reused entity index (LIFO freelist), reads the slot's
 * precomputed packed ID, appends a dense row, and initializes component
 * fields with defaults or override values (stored by reference, no clone).
 *
 * @throws If the world is out of entity indices
 * @throws If an override sets a required component to `false`
 */
export function spawn(storage: Storage, overrides?: SpawnOverrides): EntityId {
  const state = storage.world;

  // Allocate an entity index (from freelist or fresh)
  let index: number;
  if (state.freeHead !== -1) {
    // Pop from freelist: the dead sparse slot holds the next pointer
    index = state.freeHead;
    state.freeHead = state.sparse[index]!;
  } else {
    // Fresh allocation
    index = state.nextIndex;
    assertEntityIndex(index);
    state.nextIndex = index + 1;
    if (index >= state.generation.length) {
      growWorldArrays(state);
    }
    // Fresh slot init: gen 1 (gen 0 is the never-allocated sentinel)
    state.generation[index] = initialEntityId(index);
  }

  // The slot's packed ID is precomputed — spawn packs nothing
  const eid = state.generation[index] as EntityId;

  // Append dense row (grow first so the writes land in the live arrays)
  const di = storage.n;
  if (di >= storage.entities.length) {
    growStorageArrays(storage);
  }
  storage.n = di + 1;
  storage.entities[di] = eid;
  state.sparse[index] = di;
  state.entityArch[index] = storage;

  initSoaFields(storage, di, overrides);
  storage.mask[di] = 0;

  return eid;
}

/** Copy a column into a double-capacity replacement of the same constructor. */
function grownColumn<T extends TypedArray>(col: T, capacity: number): T {
  const ctor = col.constructor as new (n: number) => T;
  const next = new ctor(capacity);
  next.set(col);
  return next;
}

/**
 * Grow world arrays (generation, sparse, entityArch) to double capacity and
 * refresh the aliases on every registered storage — nothing may keep pointing
 * at a replaced array.
 */
function growWorldArrays(state: WorldState): void {
  const capacity = state.generation.length * 2;
  state.generation = grownColumn(state.generation, capacity);
  state.sparse = grownColumn(state.sparse, capacity);
  state.entityArch.length = capacity;

  for (const storage of state.storages.values()) {
    storage.generation = state.generation;
    storage.sparse = state.sparse;
  }
}

/**
 * Grow every parallel array of a storage together (entities, mask, all
 * TypedArray columns) to double capacity. Plain-Array columns (ref/string)
 * auto-extend on indexed assignment and are never replaced, so despawnClear
 * references stay valid. flatColumns is rebuilt from the updated columns.
 */
function growStorageArrays(storage: Storage): void {
  const capacity = storage.entities.length * 2;
  storage.entities = grownColumn(storage.entities, capacity);
  storage.mask = grownColumn(storage.mask, capacity);

  for (const soa of storage.columns.values()) {
    for (const [fieldName, col] of Object.entries(soa)) {
      if (!Array.isArray(col)) {
        soa[fieldName] = grownColumn(col, capacity);
      }
    }
  }

  const flatColumns: (TypedArray | Array<unknown>)[] = [];
  for (const soa of storage.columns.values()) {
    for (const col of Object.values(soa)) {
      flatColumns.push(col);
    }
  }
  storage.flatColumns = flatColumns;
}

/**
 * Initialize SoA fields for a spawned entity: per required component, write
 * the override value when present (`!== undefined`), else the default for
 * non-ref fields. Ref fields with no override stay undefined.
 */
function initSoaFields(storage: Storage, di: number, overrides?: SpawnOverrides): void {
  for (const comp of storage.archetype.components) {
    const fieldOverrides = resolveRequiredOverride(comp.__ecstatic_name, overrides);

    const soa = storage.columns.get(comp)!;
    const fields = comp.__ecstatic_fields;
    const defaultValues = comp.__ecstatic_default_values;
    const isRef = comp.__ecstatic_is_reference;

    for (let i = 0; i < fields.length; i++) {
      const fieldName = fields[i]!;
      const override = fieldOverrides?.[fieldName];
      if (override !== undefined) {
        soa[fieldName]![di] = override;
      } else if (isRef[i] !== true) {
        soa[fieldName]![di] = defaultValues[i];
      }
      // Ref fields without an override stay undefined (despawn cleared the slot)
    }
  }
}

/**
 * Resolve a required component's spawn override: a record overrides fields,
 * `true` means defaults, `false` is an error (required components cannot be
 * disabled), absent means defaults.
 */
function resolveRequiredOverride(
  name: string,
  overrides?: SpawnOverrides,
): Record<string, unknown> | undefined {
  const raw = overrides?.[name];
  if (raw === undefined || raw === true) {
    return undefined;
  }
  if (raw === false) {
    throw new Error(`required component ${name} cannot be disabled at spawn`);
  }
  return raw;
}
