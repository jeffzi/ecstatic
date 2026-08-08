/**
 * Entity spawning: allocate entity IDs, initialize component fields.
 */

import type { ArchetypeDescriptor, ComponentsOf, OptionalsOf } from "../archetype.js";
import type { ComponentFields, ComponentName } from "../component.js";
import type { EntityId } from "../entity-id.js";
import {
  assertEntityIndex,
  initialEntityId,
  MAX_INDEX,
  NO_FREE_SLOT,
  OVERFLOW_MSG,
} from "../entity-id.js";
import { growMatcherArrays, maskSatisfies, refreshMatchersMask } from "../matcher.js";
import { collectFlatColumns } from "../world.js";
import type { Storage, TypedArray, WorldState } from "../world.js";

/**
 * Per-component spawn overrides, keyed by component name.
 *
 * A record value overrides individual fields (omitted fields take defaults).
 * `true` means "use defaults"; `false` on a required component is an error.
 */
export type SpawnOverrides = Record<string, Record<string, unknown> | boolean>;

/**
 * True when a component's declared fields shape is a tag (zero fields).
 * `Tag<N>` fields are `Record<string, never>`, so tag detection uses
 * assignability, not `keyof F extends never`.
 */
export type IsTagFields<F> = F extends Record<string, never> ? true : false;

/**
 * Required-component override: `true` for defaults or a partial field record.
 * Required tags narrow to literal `true` — there are no fields to patch.
 */
type RequiredSpawnValue<P> =
  IsTagFields<ComponentFields<P>> extends true ? true : Partial<ComponentFields<P>> | true;

/**
 * Optional-component override: `true` enables with defaults, `false` stays
 * disabled, and data-carrying optionals additionally accept a field record
 * (enable + patch). Tag optionals accept only booleans. Shared with the
 * `enable`/`enableMany` record grammar.
 */
export type OptionalSpawnValue<P> =
  IsTagFields<ComponentFields<P>> extends true ? boolean : boolean | Partial<ComponentFields<P>>;

/**
 * Typed spawn overrides for a storage's archetype: per-component partial
 * field records (or `true` for defaults) for required components, and the
 * `true`/`false`/record grammar for optionals. Wrong component names, unknown
 * fields, and wrong value types are compile errors; `false` on a required
 * component is rejected at the type level. Falls back to the untyped record
 * form for a bare `Storage`.
 */
export type SpawnOverridesFor<A extends ArchetypeDescriptor> = ArchetypeDescriptor extends A
  ? SpawnOverrides
  : { [P in ComponentsOf<A>[number] as ComponentName<P>]?: RequiredSpawnValue<P> } & {
      [P in OptionalsOf<A>[number] as ComponentName<P>]?: OptionalSpawnValue<P>;
    };

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
export function spawn<A extends ArchetypeDescriptor>(
  storage: Storage<A>,
  overrides?: SpawnOverridesFor<A>,
): EntityId;
export function spawn(storage: Storage, overrides?: SpawnOverrides): EntityId {
  const state = storage.world;

  const index = allocateOneIndex(state);

  // The slot's packed ID is precomputed — spawn packs nothing
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- branded type boundary
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
  if (storage.hasOptionalData) {
    writeOptionalDefaults(storage, di, 1);
  }
  const spawnMask = applyOptionalOverrides(storage, di, 1, overrides);
  storage.mask[di] = spawnMask;
  // Unconditional refresh: a recycled row holds the previous occupant's
  // matched flags.
  refreshMatchersMask(storage, di, spawnMask);

  return eid;
}

/**
 * Allocate a single entity index: pop from the freelist if one is available,
 * otherwise allocate fresh (growing world arrays and initializing the slot's
 * generation value as needed).
 */
function allocateOneIndex(state: WorldState): number {
  if (state.freeHead !== NO_FREE_SLOT) {
    // Pop from freelist: the dead sparse slot holds the next pointer
    const index = state.freeHead;
    state.freeHead = state.sparse[index]!;
    return index;
  }

  const index = state.nextIndex;
  assertEntityIndex(index);
  state.nextIndex = index + 1;
  if (index >= state.generation.length) {
    growWorldArrays(state);
  }
  // Fresh slot init: gen 1 (gen 0 is the never-allocated sentinel)
  state.generation[index] = initialEntityId(index);
  return index;
}

/** Copy a column into a double-capacity replacement of the same constructor. */
function grownColumn<T extends TypedArray>(col: T, capacity: number): T {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- TypedArray constructor pattern
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

  storage.flatColumns = collectFlatColumns(storage.columns);
  growMatcherArrays(storage, capacity);
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
 * Pre-populate optional-component columns with declared defaults for `count`
 * rows starting at `denseStart` (column-major). Runs on every spawn — fresh
 * and recycled — so a previous occupant's values never resurface; override
 * patches land on top afterwards. Ref fields stay untouched: despawn already
 * cleared their slots.
 */
function writeOptionalDefaults(storage: Storage, denseStart: number, count: number): void {
  for (const comp of storage.archetype.optionals) {
    const soa = storage.columns.get(comp);
    if (soa === undefined) {
      continue;
    }
    const fields = comp.__ecstatic_fields;
    const defaultValues = comp.__ecstatic_default_values;
    const isRef = comp.__ecstatic_is_reference;

    for (let fieldIdx = 0; fieldIdx < fields.length; fieldIdx++) {
      if (isRef[fieldIdx] === true) {
        continue;
      }
      const col = soa[fields[fieldIdx]!]!;
      const defaultValue = defaultValues[fieldIdx];
      for (let i = 0; i < count; i++) {
        col[denseStart + i] = defaultValue;
      }
    }
  }
}

/**
 * Resolve optional spawn overrides for `count` rows starting at `denseStart`
 * and return the accumulated presence mask: `true` enables with the
 * pre-populated defaults, a record enables and patches the listed fields on
 * top of them, `false`/absent stays disabled.
 *
 * Iterates the archetype's optionals, so unknown override keys are silently
 * ignored (the types reject them) — unlike `enable`, whose record form
 * throws on unknown names at runtime.
 */
// Spawn hot path: the override grammar's per-kind continues and the
// column-major field loops stay fused in one function so a batch pays one
// pass over the resolved overrides.
// fallow-ignore-next-line complexity
function applyOptionalOverrides(
  storage: Storage,
  denseStart: number,
  count: number,
  overrides: SpawnOverrides | undefined,
): number {
  if (overrides === undefined) {
    return 0;
  }

  let bits = 0;
  for (const comp of storage.archetype.optionals) {
    const raw = overrides[comp.__ecstatic_name];
    if (raw === undefined || raw === false) {
      continue;
    }
    bits |= storage.optionalBitLookup.get(comp)!;
    if (raw === true) {
      continue;
    }

    const soa = storage.columns.get(comp);
    if (soa === undefined) {
      continue;
    }
    const fields = comp.__ecstatic_fields;
    for (let fieldIdx = 0; fieldIdx < fields.length; fieldIdx++) {
      const override = raw[fields[fieldIdx]!];
      if (override === undefined) {
        continue;
      }
      const col = soa[fields[fieldIdx]!]!;
      for (let i = 0; i < count; i++) {
        col[denseStart + i] = override;
      }
    }
  }
  return bits;
}

/**
 * Allocate entity indices and fill dense rows and SoA fields for a batch of
 * `count` entities, writing the spawned ids into `out`.
 *
 * `out` is the caller's buffer on the out-parameter path and a fresh array
 * otherwise — one code shape, so a reused buffer costs no extra allocation or
 * copy. Ids are written at ascending indices (growing a short buffer in place),
 * then the length is set to trim any tail left by a longer buffer.
 *
 * Allocation is fused into the fill loop so no intermediate index array is
 * built. Safe because a freelist pop never reads a sparse slot written earlier
 * in the same batch: a popped slot leaves the chain before its sparse entry is
 * overwritten with a dense index.
 *
 * Assumes overflow was pre-checked and storage.n is the end of the batch.
 */
function fillBatch(
  storage: Storage,
  count: number,
  overrides: SpawnOverrides | undefined,
  out: EntityId[],
): void {
  const state = storage.world;
  const denseStart = storage.n - count;

  for (let i = 0; i < count; i++) {
    const index = allocateOneIndex(state);
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- branded type boundary
    const eid = state.generation[index] as EntityId;
    const di = denseStart + i;

    out[i] = eid;
    storage.entities[di] = eid;
    state.sparse[index] = di;
    state.entityArch[index] = storage;
    storage.mask[di] = 0;
  }
  out.length = count;

  initComponentFields(storage, denseStart, count, overrides);
  if (storage.hasOptionalData) {
    writeOptionalDefaults(storage, denseStart, count);
  }
  const optionalBits = applyOptionalOverrides(storage, denseStart, count, overrides);
  if (optionalBits !== 0) {
    for (let i = 0; i < count; i++) {
      storage.mask[denseStart + i] = optionalBits;
    }
  }

  // Batch matcher refresh: the whole batch shares one mask, so each
  // matcher's matched value is constant over the new range — computed once
  // per matcher, filled per row. Unconditional for the same recycled-row
  // reason as single spawn.
  const matcherN = storage.matchers.length;
  if (matcherN !== 0) {
    const matchers = storage.matchers;
    for (let mi = 0; mi < matcherN; mi++) {
      const m = matchers[mi]!;
      const matchedValue = maskSatisfies(optionalBits, m.allMask, m.anyMask, m.noneMask) ? 1 : 0;
      const matched = m.matched;
      for (let i = 0; i < count; i++) {
        matched[denseStart + i] = matchedValue;
      }
    }
  }
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
export function spawnMany<A extends ArchetypeDescriptor>(
  storage: Storage<A>,
  count: number,
  out: EntityId[],
): EntityId[];
export function spawnMany<A extends ArchetypeDescriptor>(
  storage: Storage<A>,
  count: number,
  overrides?: SpawnOverridesFor<A>,
  out?: EntityId[],
): EntityId[];
export function spawnMany(
  storage: Storage,
  count: number,
  overridesOrOut?: SpawnOverrides | EntityId[],
  out?: EntityId[],
): EntityId[] {
  const isOutBuffer = Array.isArray(overridesOrOut);
  const overrides = isOutBuffer ? undefined : overridesOrOut;
  const outBuffer = isOutBuffer ? overridesOrOut : out;

  const state = storage.world;

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

  // fillBatch derives denseStart from storage.n - count, so the new count must
  // be committed first.
  storage.n = denseEnd;

  // Allocate indices (may grow world arrays) and fill dense rows and component
  // fields, writing ids straight into the caller's buffer when one was supplied
  const result = outBuffer ?? [];
  fillBatch(storage, count, overrides, result);

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
  while (freeWalk !== NO_FREE_SLOT && freeCount < count) {
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
