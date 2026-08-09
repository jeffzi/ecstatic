/**
 * Entity spawning: allocate entity IDs, initialize component fields.
 */

import type { ArchetypeDescriptor, ComponentsOf, OptionalsOf } from "../archetype.js";
import type { ComponentDescriptor, ComponentFields, ComponentName } from "../component.js";
import { DEBUG } from "../debug.js";
import type { EntityId, With } from "../entity-id.js";
import {
  assertEntityIndex,
  entityIndex,
  initialEntityId,
  MAX_INDEX,
  NO_FREE_SLOT,
  OVERFLOW_MSG,
} from "../entity-id.js";
import {
  errorOptionalRelationTarget,
  errorRequiredRelationTarget,
  errorStaleTarget,
} from "../errors.js";
import { growMatcherArrays, maskSatisfies, refreshMatchersMask } from "../matcher.js";
import type { RelationFields } from "../relation.js";
import { getRelationMeta } from "../relation.js";
import { collectFlatColumns } from "../world.js";
import type { SoAColumns, Storage, TypedArray, WorldState } from "../world.js";
import { reverseInsert } from "./reverse-map.js";

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

/** True when the component slot is a relation descriptor. */
type IsRelationSlot<P> = P extends { readonly __ecstatic_relation_meta: unknown } ? true : false;

/**
 * Relation spawn override: a mandatory target satisfying the relation's
 * constraints, plus optional data-field patches (birth-link semantics —
 * `true` cannot link, and a record without `target` cannot either).
 */
type RelationSpawnValue<P> = P extends {
  readonly __ecstatic_relation_meta: {
    constraints: infer C extends readonly ComponentDescriptor[];
  };
}
  ? { target: With<C> } & Partial<RelationFields<P>>
  : never;

/** Names of the required components that are relations (never for bare descriptors). */
type RequiredRelationName<P> = P extends { readonly __ecstatic_relation_meta: unknown }
  ? ComponentName<P>
  : never;

/** Union of required-relation names on an archetype — non-optional spawn keys. */
export type RequiredRelationNames<A extends ArchetypeDescriptor> = ArchetypeDescriptor extends A
  ? never
  : RequiredRelationName<ComponentsOf<A>[number]>;

/**
 * Storages whose archetype carries a required relation are rejected — used by
 * the spawn forms that can omit overrides, which cannot provide the mandatory
 * birth-link target.
 */
type WithoutRequiredRelations<A extends ArchetypeDescriptor> = Storage<A> &
  (RequiredRelationNames<A> extends never ? unknown : never);

/**
 * Required-component override: `true` for defaults or a partial field record.
 * Required tags narrow to literal `true` — there are no fields to patch.
 * Required relations take the `{target, ...fields}` form only.
 */
type RequiredSpawnValue<P> =
  IsRelationSlot<P> extends true
    ? RelationSpawnValue<P>
    : IsTagFields<ComponentFields<P>> extends true
      ? true
      : Partial<ComponentFields<P>> | true;

/**
 * Optional-component override: `true` enables with defaults, `false` stays
 * disabled, and data-carrying optionals additionally accept a field record
 * (enable + patch). Tag optionals accept only booleans. Optional relations
 * birth-link with the `{target, ...fields}` form (`false`/omitted stays
 * disabled; `true` cannot link). Shared with the `enable`/`enableMany`
 * record grammar.
 */
export type OptionalSpawnValue<P> =
  IsRelationSlot<P> extends true
    ? false | RelationSpawnValue<P>
    : IsTagFields<ComponentFields<P>> extends true
      ? boolean
      : boolean | Partial<ComponentFields<P>>;

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
  : {
      [P in ComponentsOf<A>[number] as IsRelationSlot<P> extends true
        ? never
        : ComponentName<P>]?: RequiredSpawnValue<P>;
    } & {
      // Required relations MUST be provided at spawn — their keys are non-optional.
      [P in ComponentsOf<A>[number] as IsRelationSlot<P> extends true
        ? ComponentName<P>
        : never]: RelationSpawnValue<P>;
    } & {
      [P in OptionalsOf<A>[number] as ComponentName<P>]?: OptionalSpawnValue<P>;
    };

/**
 * Spawn an entity with optional component field overrides.
 *
 * Allocates a fresh or reused entity index (LIFO freelist), reads the slot's
 * precomputed packed ID, appends a dense row, and initializes component
 * fields with defaults or override values (stored by reference, no clone).
 *
 * Atomic in checked mode: a relation birth-link target that is missing, 0, or
 * stale is rejected before any allocation, so the world is left untouched.
 *
 * @throws If the world is out of entity indices
 * @throws If an override sets a required component to `false`
 * @throws (checked mode) If a relation birth-link target is missing, 0, or stale
 */
export function spawn<A extends ArchetypeDescriptor>(
  storage: WithoutRequiredRelations<A>,
  overrides?: SpawnOverridesFor<A>,
): EntityId<A>;
export function spawn<A extends ArchetypeDescriptor>(
  storage: Storage<A>,
  overrides: SpawnOverridesFor<A>,
): EntityId<A>;
export function spawn(storage: Storage, overrides?: SpawnOverrides): EntityId {
  const state = storage.world;

  if (DEBUG && storage.relationN > 0) {
    assertRelationTargets(storage, overrides);
  }

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

  // Guarded so relation-free archetypes skip the call entirely.
  if (storage.relationN > 0) {
    insertRequiredRelationEntries(storage, di, 1);
  }

  return eid;
}

/**
 * Validate every relation birth-link target in `overrides` before a row exists
 * (DEBUG-gated at the call sites).
 *
 * Running ahead of allocation is what makes a rejected checked-mode spawn
 * atomic. The write path commits `storage.n`, `entityArch`, the presence mask,
 * the target column, the matcher flags, and reverse-map entries with no unwind,
 * so a throw from inside it leaves a half-spawned row that `each` still visits
 * and that a matcher can match on a recycled row's stale presence bit. Every
 * value-dependent relation check belongs here, never in the write path.
 *
 * `relationDescriptors` lists required relations before optionals, so errors
 * surface in archetype declaration order.
 */
function assertRelationTargets(storage: Storage, overrides: SpawnOverrides | undefined): void {
  const relN = storage.relationN;
  for (let ri = 0; ri < relN; ri++) {
    const name = storage.relationDescriptors[ri]!.__ecstatic_name;
    const optional = storage.relationOptionalBits[ri] !== 0;
    assertRelationTarget(storage.world, name, optional, overrides?.[name]);
  }
}

/**
 * Validate one relation's spawn override value against the birth-link grammar:
 * a required relation must name a live target, an optional one may omit the
 * birth link entirely but cannot name a dead or sentinel target.
 */
function assertRelationTarget(
  state: WorldState,
  name: string,
  optional: boolean,
  raw: Record<string, unknown> | boolean | undefined,
): void {
  // `false` on an optional relation means "stay unlinked"; on a required one
  // resolveRequiredOverride owns the "cannot be disabled" error.
  if (raw === false) {
    return;
  }

  const rawTarget = raw === undefined || raw === true ? undefined : raw.target;
  if (rawTarget === undefined) {
    if (optional) {
      return;
    }
    throw new Error(errorRequiredRelationTarget(name));
  }

  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- override targets are EntityIds (branded numbers)
  const target = rawTarget as number;
  if (target === 0) {
    throw new Error(
      optional ? errorOptionalRelationTarget(name) : errorRequiredRelationTarget(name),
    );
  }
  if (state.generation[entityIndex(target)] !== target) {
    throw new Error(errorStaleTarget(name));
  }
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

  // Growth replaced the TypedArray target columns: refresh the cached
  // references (parallel to the flatColumns rebuild).
  const relN = storage.relationN;
  for (let ri = 0; ri < relN; ri++) {
    const targetCol = storage.columns.get(storage.relationDescriptors[ri]!)?.target;
    if (targetCol instanceof Float64Array) {
      storage.relationTargetColumns[ri] = targetCol;
    }
  }

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

    // Target column lives outside __ecstatic_fields, directly in the SoA.
    if (getRelationMeta(comp) !== undefined) {
      initRelationTarget(soa, denseStart, count, fieldOverrides?.target);
    }
  }
}

/**
 * Initialize a relation's target column for `count` rows: the override target
 * when provided, else sentinel 0. Unlinked relations store 0 (not undefined)
 * so liveness checks fail naturally — no live packed id is ever 0
 * (generations start at MAX_INDEX + index), so 0 exclusively means
 * "not linked".
 */
function initRelationTarget(
  soa: SoAColumns,
  denseStart: number,
  count: number,
  targetOverride: unknown,
): void {
  const targetCol = soa.target;
  if (targetCol === undefined) {
    return;
  }
  for (let i = 0; i < count; i++) {
    targetCol[denseStart + i] = targetOverride !== undefined ? targetOverride : 0;
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

    // Relation target sentinel: write 0 so despawn's target !== 0 check never
    // reads a previous occupant's target on a recycled row.
    if (getRelationMeta(comp) !== undefined) {
      initRelationTarget(soa, denseStart, count, undefined);
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

    // Optional relation birth-link: presence bit is already set above and
    // data fields patched (the synthetic target column is not in
    // __ecstatic_fields); write the target and record the reverse entries.
    if (getRelationMeta(comp) !== undefined && raw.target !== undefined) {
      birthLinkOptional(storage, denseStart, count, comp, soa, raw.target);
    }
  }
  return bits;
}

/**
 * Birth-link an optional relation for `count` rows starting at `denseStart`:
 * write the target column and record each source in the target's reverse
 * bucket. Targets are pre-validated by `assertRelationTargets`, so this write
 * path never throws — see that function before adding a check here.
 */
function birthLinkOptional(
  storage: Storage,
  denseStart: number,
  count: number,
  comp: ComponentDescriptor,
  soa: SoAColumns,
  rawTarget: unknown,
): void {
  const state = storage.world;
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- override targets are EntityIds (branded numbers)
  const target = rawTarget as number;
  // Only reachable under NDEBUG, where the 0 sentinel is unvalidated: leave the
  // sentinel in place so the row spawns unlinked with no reverse entry.
  if (target === 0) {
    return;
  }
  const targetCol = soa.target!;
  const targetIdx = entityIndex(target);
  for (let i = 0; i < count; i++) {
    const di = denseStart + i;
    targetCol[di] = target;
    reverseInsert(state, comp, targetIdx, storage, entityIndex(storage.entities[di]!));
  }
}

/**
 * Record reverse-map entries for the required relations of `count` freshly
 * spawned rows, reading targets from the already-initialized target columns.
 *
 * Target presence (0 = not provided) and liveness are validated by
 * `assertRelationTargets` before the row exists — a stale target would seed a
 * reverse entry that aliases onto a reused slot. Under NDEBUG both checks are
 * absent: the entity spawns unlinked on a 0 target, and no reverse entry is
 * recorded.
 */
function insertRequiredRelationEntries(storage: Storage, denseStart: number, count: number): void {
  const state = storage.world;
  const relCols = storage.relationTargetColumns;
  const relDescriptors = storage.relationDescriptors;
  const relBits = storage.relationOptionalBits;
  const relN = storage.relationN;

  for (let ri = 0; ri < relN; ri++) {
    if (relBits[ri] !== 0) {
      continue;
    }
    const col = relCols[ri]!;
    const relDesc = relDescriptors[ri]!;
    for (let i = 0; i < count; i++) {
      const di = denseStart + i;
      insertRequiredEntry(state, storage, relDesc, col[di]!, di);
    }
  }
}

/**
 * Record one required-relation birth entry. A 0 target means "not provided",
 * only reachable under NDEBUG, where the entity is left unlinked with no
 * reverse entry.
 */
function insertRequiredEntry(
  state: WorldState,
  storage: Storage,
  relDesc: ComponentDescriptor,
  target: number,
  di: number,
): void {
  if (target === 0) {
    return;
  }
  reverseInsert(state, relDesc, entityIndex(target), storage, entityIndex(storage.entities[di]!));
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

  if (storage.relationN > 0) {
    insertRequiredRelationEntries(storage, denseStart, count);
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
 * Atomic: no mutation occurs if allocation would overflow MAX_INDEX, or if
 * checked mode rejects a relation birth-link target.
 *
 * @throws If the batch would exceed entity index capacity
 * @throws (checked mode) If a relation birth-link target is missing, 0, or stale
 */
export function spawnMany<A extends ArchetypeDescriptor>(
  storage: WithoutRequiredRelations<A>,
  count: number,
  out: EntityId[],
): EntityId<A>[];
export function spawnMany<A extends ArchetypeDescriptor>(
  storage: WithoutRequiredRelations<A>,
  count: number,
  overrides?: SpawnOverridesFor<A>,
  out?: EntityId[],
): EntityId<A>[];
export function spawnMany<A extends ArchetypeDescriptor>(
  storage: Storage<A>,
  count: number,
  overrides: SpawnOverridesFor<A>,
  out?: EntityId[],
): EntityId<A>[];
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

  if (DEBUG && storage.relationN > 0) {
    assertRelationTargets(storage, overrides);
  }

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
