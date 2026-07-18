/**
 * Entity spawning: allocate entity IDs, initialize component fields.
 */

import type { EntityId } from "../entity-id.js";
import { assertEntityIndex, initialEntityId, MAX_INDEX, OVERFLOW_MSG } from "../entity-id.js";
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

  initComponentFields(storage, di, 1, overrides);
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
 * Initialize SoA fields for `count` dense rows starting at `denseStart`:
 * per required component, per field (column-major), write the override value
 * when present (`!== undefined`), else the default for non-ref fields.
 * Ref fields with no override stay undefined (despawn cleared the slot).
 */
function initComponentFields(
  storage: Storage,
  denseStart: number,
  count: number,
  overrides?: SpawnOverrides,
): void {
  for (const comp of storage.archetype.components) {
    const fieldOverrides = resolveRequiredOverride(comp.__ecstatic_name, overrides);

    const soa = storage.columns.get(comp)!;
    const fields = comp.__ecstatic_fields;
    const defaultValues = comp.__ecstatic_default_values;
    const isRef = comp.__ecstatic_is_reference;

    for (let fieldIdx = 0; fieldIdx < fields.length; fieldIdx++) {
      const col = soa[fields[fieldIdx]!]!;
      const override = fieldOverrides?.[fields[fieldIdx]!];

      for (let i = 0; i < count; i++) {
        const di = denseStart + i;
        if (override !== undefined) {
          col[di] = override;
        } else if (isRef[fieldIdx] !== true) {
          col[di] = defaultValues[fieldIdx];
        }
      }
    }
  }
}

/**
 * Allocate entity indices for a batch spawn: precheck overflow, allocate from
 * freelist and fresh slots, initialize generation values. Returns the sparse
 * indices and whether world arrays grew (caller must refresh aliases if true).
 * Called only after atomic overflow pre-check has passed.
 */
function allocateIndices(
  state: WorldState,
  count: number,
): { indices: number[]; worldGrew: boolean } {
  const indices: number[] = [];
  let worldGrew = false;

  for (let i = 0; i < count; i++) {
    let index: number;
    if (state.freeHead !== -1) {
      // Pop from freelist
      index = state.freeHead;
      state.freeHead = state.sparse[index]!;
    } else {
      // Fresh allocation
      index = state.nextIndex;
      state.nextIndex = index + 1;
      if (index >= state.generation.length) {
        growWorldArrays(state);
        worldGrew = true;
      }
      // Fresh slot init: gen 1 (gen 0 is the never-allocated sentinel)
      state.generation[index] = initialEntityId(index);
    }
    indices.push(index);
  }

  return { indices, worldGrew };
}

/**
 * Fill dense rows and SoA fields for a batch of allocated entities.
 * Assumes indices have been allocated, storage.n is the start of the batch.
 */
function fillBatch(
  storage: Storage,
  count: number,
  indices: number[],
  overrides: SpawnOverrides | undefined,
): EntityId[] {
  const state = storage.world;
  const denseStart = storage.n - count;
  const result: EntityId[] = [];

  // Build entity ID array and update sparse mapping
  for (let i = 0; i < count; i++) {
    const index = indices[i]!;
    const eid = state.generation[index] as EntityId;
    const di = denseStart + i;

    result[i] = eid;
    storage.entities[di] = eid;
    state.sparse[index] = di;
    state.entityArch[index] = storage;
    storage.mask[di] = 0;
  }

  // Initialize component fields (column-major: per component, per field, loop rows)
  initComponentFields(storage, denseStart, count, overrides);

  return result;
}

/**
 * Spawn multiple entities in one call.
 *
 * Allocates count entity indices (LIFO freelist first, then fresh), reads
 * each slot's precomputed packed ID, appends dense rows, and initializes
 * component fields with the same defaults or override values applied to all.
 *
 * The 3rd argument disambiguates based on type:
 * - Array → out buffer (reused and returned)
 * - Object → overrides record (defaults otherwise)
 * - Omitted → fresh array returned
 *
 * The optional 4th argument is an out buffer (ignored if 3rd is already an array).
 *
 * Atomic: if allocation would overflow MAX_INDEX, no mutation occurs.
 *
 * @throws If the batch would exceed entity index capacity
 */
export function spawnMany(
  storage: Storage,
  count: number,
  overridesOrOut?: SpawnOverrides | EntityId[],
  out?: EntityId[],
): EntityId[] {
  // Disambiguate 3rd argument
  const isOutBuffer = Array.isArray(overridesOrOut);
  const overrides = isOutBuffer ? undefined : overridesOrOut;
  const outBuffer = isOutBuffer ? overridesOrOut : out;

  const state = storage.world;

  // Fast path: count 0 means empty result
  if (count === 0) {
    if (outBuffer) {
      outBuffer.length = 0;
      return outBuffer;
    }
    return [];
  }

  assertBatchCapacity(state, count);

  // Grow storage arrays for dense rows in one shot (after we know count)
  const denseStart = storage.n;
  const denseEnd = denseStart + count;
  while (denseEnd > storage.entities.length) {
    growStorageArrays(storage);
  }

  // Allocate indices (may grow world arrays)
  const { indices } = allocateIndices(state, count);

  // Update storage entity count before filling
  storage.n = denseEnd;

  // Fill dense rows and component fields
  const ids = fillBatch(storage, count, indices, overrides);

  // Populate result array
  const result = outBuffer ?? ids;
  if (outBuffer) {
    outBuffer.length = count;
    for (let i = 0; i < count; i++) {
      outBuffer[i] = ids[i]!;
    }
  }

  return result;
}

/**
 * Atomic overflow pre-check for a batch spawn: only the cold near-ceiling
 * path walks the freelist to count recycled slots; the common case is a
 * single comparison. Throws before any mutation.
 */
function assertBatchCapacity(state: WorldState, count: number): void {
  if (state.nextIndex + count - 1 < MAX_INDEX) {
    return;
  }
  let freeCount = 0;
  let freeWalk = state.freeHead;
  while (freeWalk !== -1 && freeCount < count) {
    freeCount++;
    freeWalk = state.sparse[freeWalk]!;
  }
  if (state.nextIndex + (count - freeCount) > MAX_INDEX) {
    throw new Error(OVERFLOW_MSG);
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
