/**
 * Entity spawning: allocate entity IDs, initialize component fields.
 */

import type { ArchetypeDescriptor, ComponentsOf, OptionalsOf } from "../archetype.js";
import type { ComponentDescriptor, ComponentFields, ComponentName } from "../component.js";
import type { EntityId, With } from "../entity-id.js";
import {
  assertEntityIndex,
  initialEntityId,
  MAX_INDEX,
  NO_FREE_SLOT,
  OVERFLOW_MSG,
} from "../entity-id.js";
import { growMatcherArrays, maskSatisfies, refreshMatchersMask } from "../matcher.js";
import type { RelationFields } from "../relation.js";
import { getRelationMeta } from "../relation.js";
import { syncColumnCaches } from "../world.js";
import type { SoAColumns, Storage, TypedArray, WorldState } from "../world.js";
import { insertRequiredRelationEntries, writeBirthRelations } from "./spawn-link.js";
import { holdSpawnOverrides, writeHeldOverrides } from "./spawn-values.js";

// ---------------------------------------------------------------------------
// Spawn override types
// ---------------------------------------------------------------------------

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
 *
 * The trailing `extends infer S ? { [K in keyof S]: S[K] } : never` is
 * display-driven: it collapses the three-way intersection into one object
 * literal so hovers and errors print flat keys instead of `{...} & {} & {...}`.
 * The mapped type stays inline — a named `Flat<T>` alias would keep its own
 * alias symbol and print `Flat<{...} & {} & {...}>` instead. Being homomorphic
 * over `keyof S`, it preserves each member's optionality modifiers.
 */
export type SpawnOverridesFor<A extends ArchetypeDescriptor> = ArchetypeDescriptor extends A
  ? SpawnOverrides
  : {
        [
          P in ComponentsOf<A>[number] as IsRelationSlot<P> extends true ? never : ComponentName<P>
        ]?: RequiredSpawnValue<P>;
      } & {
        // Required relations MUST be provided at spawn — their keys are non-optional.
        [
          P in ComponentsOf<A>[number] as IsRelationSlot<P> extends true ? ComponentName<P> : never
        ]: RelationSpawnValue<P>;
      } & {
        [P in OptionalsOf<A>[number] as ComponentName<P>]?: OptionalSpawnValue<P>;
      } extends infer S
    ? { [K in keyof S]: S[K] }
    : never;

// ---------------------------------------------------------------------------
// Single spawn
// ---------------------------------------------------------------------------

/**
 * Spawn an entity with optional component field overrides.
 *
 * Allocates a fresh or reused entity index (LIFO freelist), reads the slot's
 * precomputed packed ID, appends a dense row, and initializes component
 * fields with defaults or override values (stored by reference, no clone).
 *
 * Atomic: an exhausted index space is rejected before any override is read,
 * and every override is read and validated before any allocation, so a
 * rejected spawn or a throwing getter leaves the world untouched.
 *
 * Every override value is read exactly once, even through a getter, before the
 * row exists: a relation links to the target that was validated, and a getter
 * that spawns into the same storage or despawns another entity in it never
 * redirects a write.
 *
 * @param storage - Archetype storage the entity joins. This form accepts only archetypes without
 *   a required relation, since omitted overrides cannot supply the mandatory birth-link target;
 *   the overload with mandatory overrides accepts any storage.
 * @param overrides - Per-component values keyed by component name: a field record patches the
 *   listed fields (values stored by reference, not cloned), `true` keeps defaults, and on an
 *   optional component `false` or absence leaves it disabled. Omitted means every required
 *   component takes its defaults and no optional is enabled.
 * @returns The packed generational id of the new entity, branded with the storage's archetype.
 * @throws If the world is out of entity indices, before any getter on `overrides` runs
 * @throws If an override sets a required component or required relation to `false`
 * @throws (checked mode) If a relation birth-link target is missing, 0, or stale
 * @throws Whatever a getter on `overrides` throws; nothing is allocated or written
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

  assertBatchCapacity(state, 1);
  const heldBase = holdSpawnOverrides(storage, overrides);

  const index = allocateOneIndex(state);

  // The slot's packed ID is precomputed — spawn packs nothing. A slot freed at the generation
  // wrap holds its ID negated, so the entry is stored back positive. Not `Math.abs`: V8 returns
  // its result as a small integer while `spawnMany` ids stay doubles, and an id list mixing the
  // two drops `despawnMany`'s id loop out of optimized code.
  // oxlint-disable-next-line typescript/no-non-null-assertion -- allocated index is inside the generation table
  const entry = state.generation[index]!;
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- branded type boundary
  const eid = (entry < 0 ? -entry : entry) as EntityId;
  state.generation[index] = eid;

  // Append dense row (grow first so the writes land in the live arrays)
  const di = storage.n;
  if (di >= storage.entities.length) {
    growStorageArrays(storage);
  }
  storage.n = di + 1;
  storage.entities[di] = eid;
  state.sparse[index] = di;
  state.entityArch[index] = storage;

  if (storage.hasOptionalData) {
    writeOptionalDefaults(storage, di, 1);
  }
  const relationBits = storage.relationN > 0 ? writeBirthRelations(storage, di, 1) : 0;
  const spawnMask = writeHeldOverrides(storage, di, heldBase) | relationBits;
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

// ---------------------------------------------------------------------------
// Allocation and growth
// ---------------------------------------------------------------------------

/**
 * Allocate a single entity index: pop from the freelist if one is available, otherwise allocate
 * fresh (growing world arrays and initializing the slot's generation value as needed).
 *
 * @param state - World whose freelist, `nextIndex`, and generation table are advanced; a fresh
 *   allocation may replace `generation` and `sparse` with grown arrays, so re-read them after
 *   the call.
 * @returns The allocated entity index. A recycled slot keeps the entry despawn stored: its next
 *   packed id, negated when the slot's generation wrapped. A fresh slot is initialized to
 *   generation 1. The caller hands out the entry's absolute value and stores it back.
 * @throws If every index below `MAX_INDEX` is in use and the freelist is empty.
 */
function allocateOneIndex(state: WorldState): number {
  if (state.freeHead !== NO_FREE_SLOT) {
    // Pop from freelist: the dead sparse slot holds the next pointer
    const index = state.freeHead;
    // oxlint-disable-next-line typescript/no-non-null-assertion -- freelist index is a valid sparse slot
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

/**
 * Copy a column into a replacement of the same constructor at a new capacity.
 *
 * @param col - Typed-array column to copy from; left untouched, so callers must store the
 *   replacement everywhere the old array was aliased.
 * @param capacity - Length of the replacement; never smaller than `col.length`, or
 *   `TypedArray.set` throws.
 * @returns A fresh typed array of `col`'s constructor with `col`'s contents at the front and
 *   zeros after.
 */
function grownColumn<T extends TypedArray>(col: T, capacity: number): T {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- TypedArray constructor pattern
  const ctor = col.constructor as new (n: number) => T;
  const next = new ctor(capacity);
  next.set(col);
  return next;
}

/**
 * Grow world arrays (generation, sparse, entityArch) to double capacity and refresh the aliases
 * on every registered storage — nothing may keep pointing at a replaced array.
 *
 * @param state - World whose `generation` and `sparse` are replaced (every storage's cached
 *   aliases are rewritten to the new arrays) and whose `entityArch` is extended in place.
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
 * Grow every parallel array of a storage together (entities, mask, all TypedArray columns) to
 * double capacity. Plain-Array columns (ref/string) auto-extend on indexed assignment and are
 * never replaced, so despawnClear references stay valid. flatColumns is rebuilt and the field
 * columns are pointed at the new arrays.
 *
 * Part of the runtime contract with the optimizer: each component's SoA record (and
 * so its `storage[name]` alias) stays the same object; only the typed arrays inside it are
 * replaced, with the old values copied in.
 *
 * @param storage - Storage whose capacity doubles: `entities`, `mask`, every typed column,
 *   `flatColumns`, `relationTargetColumns`, and each matcher's `matched` array are replaced
 *   together, so any of them cached across the call is stale; `fieldColumns` update in place.
 * @throws If a field column has no matching column array (invariant guard, unreachable)
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

  syncColumnCaches(storage);

  // Growth replaced the TypedArray target columns: refresh the cached
  // references (parallel to the flatColumns rebuild).
  const relN = storage.relationN;
  for (let ri = 0; ri < relN; ri++) {
    // oxlint-disable-next-line typescript/no-non-null-assertion -- ri < relN ≤ relationDescriptors.length
    const targetCol = storage.columns.get(storage.relationDescriptors[ri]!)?.["target"];
    if (targetCol instanceof Float64Array) {
      storage.relationTargetColumns[ri] = targetCol;
    }
  }

  growMatcherArrays(storage, capacity);
}

// ---------------------------------------------------------------------------
// Field initialization
// ---------------------------------------------------------------------------

/**
 * Reset a relation's target column to the unlinked sentinel for a run of rows. Unlinked
 * relations store 0 (not undefined) so liveness checks fail naturally — no live packed id is ever
 * 0 (generations start at MAX_INDEX + index), so 0 exclusively means "not linked".
 *
 * @param soa - The relation component's column record; a record without a `target` column is a
 *   no-op.
 * @param denseStart - First dense row of the run.
 * @param count - Number of consecutive rows written.
 */
function initRelationTarget(soa: SoAColumns, denseStart: number, count: number): void {
  const targetCol = soa["target"];
  if (targetCol === undefined) {
    return;
  }
  for (let i = 0; i < count; i++) {
    targetCol[denseStart + i] = 0;
  }
}

/**
 * Pre-populate optional-component columns with declared defaults (column-major). Runs on every
 * spawn — fresh and recycled — so a previous occupant's values never resurface; override patches
 * land on top afterwards. Ref fields stay untouched: despawn already cleared their slots.
 *
 * @param storage - Storage whose optional components' columns are written; field-less tag
 *   optionals have no column record and are skipped, and relation optionals get the 0 target
 *   sentinel.
 * @param denseStart - First dense row of the run.
 * @param count - Number of consecutive rows written.
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
      initRelationTarget(soa, denseStart, count);
    }

    const fields = comp.__ecstatic_fields;
    const defaultValues = comp.__ecstatic_default_values;
    const isRef = comp.__ecstatic_is_reference;

    for (let fieldIdx = 0; fieldIdx < fields.length; fieldIdx++) {
      if (isRef[fieldIdx] === true) {
        continue;
      }
      // oxlint-disable-next-line typescript/no-non-null-assertion -- fieldIdx < fields.length
      const fieldName = fields[fieldIdx]!;
      // oxlint-disable-next-line typescript/no-non-null-assertion -- SoA column exists for every declared field
      const col = soa[fieldName]!;
      const defaultValue = defaultValues[fieldIdx];
      for (let i = 0; i < count; i++) {
        col[denseStart + i] = defaultValue;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Batch spawn and override resolution
// ---------------------------------------------------------------------------

/**
 * Batch matcher refresh: the whole batch shares one mask, so each matcher's matched value is
 * constant over the new range — computed once per matcher, filled per row. Unconditional for the
 * same recycled-row reason as single spawn.
 *
 * @param storage - Storage whose matchers' `matched` flags are written for the batch rows.
 * @param start - First row of the batch.
 * @param count - Number of rows in the batch.
 * @param mask - Optional-component mask every row of the batch shares.
 */
function refreshBatchMatchers(storage: Storage, start: number, count: number, mask: number): void {
  const matchers = storage.matchers;
  const matcherN = matchers.length;
  for (let mi = 0; mi < matcherN; mi++) {
    // oxlint-disable-next-line typescript/no-non-null-assertion -- mi < matcherN ≤ matchers.length
    const m = matchers[mi]!;
    const matchedValue = maskSatisfies(mask, m.allMask, m.anyMask, m.noneMask) ? 1 : 0;
    const matched = m.matched;
    for (let i = 0; i < count; i++) {
      matched[start + i] = matchedValue;
    }
  }
}

/**
 * Allocate entity indices and fill dense rows and SoA fields for a batch of entities.
 *
 * Allocation is fused into the fill loop so no intermediate index array is built. Safe because a
 * freelist pop never reads a sparse slot written earlier in the same batch: a popped slot leaves
 * the chain before its sparse entry is overwritten with a dense index.
 *
 * The loop stays in this function rather than a helper: V8 then optimizes it together with the
 * allocator and the field initializers below, which a separately compiled loop measured slower.
 *
 * Runs no user code: every override was read by `holdSpawnOverrides` before the rows existed.
 *
 * @param storage - Storage whose rows `[n - count, n)` are filled; `storage.n` must already have
 *   been advanced past the batch and the arrays grown to hold it.
 * @param count - Number of entities to allocate and fill; `assertBatchCapacity` must have passed
 *   for this count so no allocation overflows.
 * @param heldBase - The `heldTop` captured before `holdSpawnOverrides` read this batch's
 *   overrides; every row takes the values it held, and this call releases them and the relation
 *   slots `readBirthTargets` reserved.
 * @param out - Receives the spawned ids at indices `[0, count)`. The caller's buffer on the
 *   out-parameter path and a fresh array otherwise — one code shape, so a reused buffer costs no
 *   extra allocation or copy. Ids are written at ascending indices (growing a short buffer in
 *   place), then the length is set to `count` to trim any tail left by a longer buffer.
 * @throws If a fresh index reaches `MAX_INDEX` — unreachable once `assertBatchCapacity` passed.
 */
function fillBatch(storage: Storage, count: number, heldBase: number, out: EntityId[]): void {
  const state = storage.world;
  const denseStart = storage.n - count;

  for (let i = 0; i < count; i++) {
    const index = allocateOneIndex(state);
    // Positive again if the slot was freed at the generation wrap (see `spawn`). A sign test, not
    // the unconditional store `spawn` uses: per-row stores measured slower in this loop.
    // oxlint-disable-next-line typescript/no-non-null-assertion -- allocated index is inside the generation table
    let packedId = state.generation[index]!;
    if (packedId < 0) {
      packedId = -packedId;
      state.generation[index] = packedId;
    }
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- branded type boundary
    const eid = packedId as EntityId;
    const di = denseStart + i;

    out[i] = eid;
    storage.entities[di] = eid;
    state.sparse[index] = di;
    state.entityArch[index] = storage;
    storage.mask[di] = 0;
  }
  out.length = count;

  if (storage.hasOptionalData) {
    writeOptionalDefaults(storage, denseStart, count);
  }
  const relationBits = storage.relationN > 0 ? writeBirthRelations(storage, denseStart, count) : 0;
  const optionalBits = writeHeldOverrides(storage, denseStart, heldBase) | relationBits;
  if (optionalBits !== 0) {
    for (let i = 0; i < count; i++) {
      storage.mask[denseStart + i] = optionalBits;
    }
  }

  refreshBatchMatchers(storage, denseStart, count, optionalBits);

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
 * Atomic: no mutation occurs if allocation would overflow MAX_INDEX, and
 * every override is read and validated before any allocation, so a rejected
 * batch or a throwing getter leaves the world untouched.
 *
 * Every override value is read exactly once for the whole batch, even through
 * a getter, before any row exists: every entity links to the target that was
 * validated, and a getter that spawns into the same storage or despawns
 * another entity in it never redirects a write.
 *
 * @param storage - Archetype storage the entities join. This form takes no overrides, so it
 *   accepts only archetypes without a required relation (nothing could supply the mandatory
 *   birth-link target); the overrides forms accept any storage.
 * @param count - Number of entities to spawn; `0` allocates nothing and returns `out` emptied.
 * @param overrides - Per-component values applied identically to every row, keyed by component
 *   name; omitted means defaults everywhere with no optional enabled. Each value is read once
 *   for the whole batch.
 * @param out - Caller-owned buffer that receives the ids: written from index 0, grown in place
 *   when shorter than `count`, then truncated so `out.length === count`. An array in this third
 *   position selects this overload; the overrides forms take the buffer as an optional fourth
 *   argument instead, and omitting it altogether returns a fresh array.
 * @returns `out` itself, holding the ids in allocation order (recycled freelist slots first,
 *   then fresh indices), each branded with the storage's archetype.
 * @throws If the batch would exceed entity index capacity
 * @throws If an override sets a required component or required relation to `false`
 * @throws (checked mode) If a relation birth-link target is missing, 0, or stale
 * @throws Whatever a getter on the overrides throws; nothing is allocated or written
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
    if (outBuffer !== undefined) {
      outBuffer.length = 0;
      return outBuffer;
    }
    return [];
  }

  assertBatchCapacity(state, count);
  const heldBase = holdSpawnOverrides(storage, overrides);

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
  fillBatch(storage, count, heldBase, result);

  return result;
}

/**
 * Atomic overflow pre-check for a spawn of `count` entities: only the cold near-ceiling path walks the
 * freelist to count recycled slots; the common case is a single comparison. Runs before any
 * mutation.
 *
 * @param state - World whose `nextIndex` and freelist decide how many fresh indices the batch
 *   needs; read only.
 * @param count - Batch size; the check passes when the fresh indices still required after
 *   recycling every free slot all stay below `MAX_INDEX`.
 * @throws If `count` entities cannot be allocated without an index reaching `MAX_INDEX`.
 */
function assertBatchCapacity(state: WorldState, count: number): void {
  if (state.nextIndex + count - 1 < MAX_INDEX) {
    return;
  }
  let freeCount = 0;
  let freeWalk = state.freeHead;
  while (freeWalk !== NO_FREE_SLOT && freeCount < count) {
    freeCount++;
    // oxlint-disable-next-line typescript/no-non-null-assertion -- freeWalk is a valid freelist index
    freeWalk = state.sparse[freeWalk]!;
  }
  if (state.nextIndex + (count - freeCount) > MAX_INDEX) {
    throw new Error(OVERFLOW_MSG);
  }
}
