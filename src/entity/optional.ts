/**
 * Optional-component toggles: flip per-row presence bits on and off.
 *
 * `enable` sets a component's mask bit and optionally patches its SoA fields;
 * `disable` clears the bit and touches no data, so a later `enable` with no
 * values resumes the retained slot values. Both take a component, a component
 * array (`disable`), or a record (`enable`), and dispatch by id from a world
 * handle when given one.
 */

import type { ComponentDescriptor, ComponentFields } from "../component.js";
import { isComponentDescriptor } from "../component.js";
import type { EntityId } from "../entity-id.js";
import { entityIndex } from "../entity-id.js";
import {
  ERROR_DISABLE_EMPTY,
  ERROR_DISABLE_MANY_EMPTY,
  errorNotOptional,
  errorRelationToggle,
  errorUnknownComponent,
} from "../errors.js";
import { applyMaskAnd, applyMaskOr, refreshMatchersAll, refreshMatchersRows } from "../matcher.js";
import { getRelationMeta } from "../relation.js";
import type { SoAColumns, Storage, World } from "../world.js";
import { resolveEntityArch, validateEntity } from "./common.js";
import type {
  AllNames,
  ArchetypeOfStorage,
  CheckOptional,
  CheckOptionalList,
  OptionalNames,
  OptionalOverridesFor,
} from "./optional-types.js";

export type { CheckOptional, CheckOptionalList, OptionalOverridesFor } from "./optional-types.js";

// ---------------------------------------------------------------------------
// Toggle primitives
// ---------------------------------------------------------------------------

/** Rejects relation components in enable/disable operations — link/unlink own them. */
function rejectRelation(comp: ComponentDescriptor, targetOp: "link" | "unlink"): void {
  const rel = getRelationMeta(comp);
  if (rel !== undefined) {
    throw new Error(errorRelationToggle(rel.__ecstatic_name, targetOp));
  }
}

/**
 * Write per-field value overrides into a component's SoA columns at dense
 * index `di`. Only fields present in `values` are written; absent fields keep
 * their current slot values. Values are stored by reference (no clone).
 */
export function writeFieldOverrides(
  soa: SoAColumns,
  fields: string[],
  di: number,
  values: Record<string, unknown>,
): void {
  for (let i = 0; i < fields.length; i++) {
    // oxlint-disable-next-line typescript/no-non-null-assertion -- i < fields.length
    const f = fields[i]!;
    if (values[f] !== undefined) {
      // oxlint-disable-next-line typescript/no-non-null-assertion -- SoA column exists for every declared field
      soa[f]![di] = values[f];
    }
  }
}

/** Enable one optional component on a single dense row: sets the presence bit
 * and, when `values` is given, patches the component's SoA fields (skipped for
 * tag components). */
export function enableOne(
  storage: Storage,
  di: number,
  comp: ComponentDescriptor,
  values?: Record<string, unknown>,
): void {
  const bit = storage.optionalBitLookup.get(comp);
  if (bit === undefined) {
    throw new Error(errorNotOptional(comp.__ecstatic_name));
  }

  applyMaskOr(storage, di, bit);

  // Only populate SoA columns for data-carrying components (skip pure tags)
  const soa = storage.columns.get(comp);
  if (soa !== undefined && values !== undefined) {
    writeFieldOverrides(soa, comp.__ecstatic_fields, di, values);
  }
}

/** Disable one optional component on a single dense row: clears the presence
 * bit, leaving slot data intact (a later `enableOne` with no values resumes
 * the retained values). */
export function disableOne(storage: Storage, di: number, comp: ComponentDescriptor): void {
  const notBit = storage.optionalNotBitLookup.get(comp);
  if (notBit === undefined) {
    throw new Error(errorNotOptional(comp.__ecstatic_name));
  }

  // oxlint-disable-next-line typescript/no-non-null-assertion -- notBit lookup above succeeded, so bit is also present
  const bit = storage.optionalBitLookup.get(comp)!;
  applyMaskAnd(storage, di, bit, notBit);
}

// ---------------------------------------------------------------------------
// Enable resolution
// ---------------------------------------------------------------------------

// Shared scratch and helpers: enable()'s record form and enableMany() both
// resolve overrides through this state before mutating any row.
// BATCH_DENSE_INDICES is also reused by disableMany() via resolveBatchIndices.

// Module-level scratch reused across calls (despawn.ts pattern): the
// resolved (comp, values) override list and the per-id dense indices.
const RESOLVED_COMPS: ComponentDescriptor[] = [];
const RESOLVED_VALUES: (Record<string, unknown> | undefined)[] = [];
const BATCH_DENSE_INDICES: number[] = [];

/**
 * Resolve all (name → comp, values) pairs up front so an unknown name or a
 * non-optional component errors before any mutation. `false` entries are
 * filtered out here so they never enter the per-entity loops. Returns the
 * resolved count; entries land in the module scratch arrays.
 */
function resolveEnableOverrides(
  storage: Storage,
  overrides: Record<string, Record<string, unknown> | boolean>,
): number {
  let n = 0;
  for (const [name, values] of Object.entries(overrides)) {
    if (values === false) {
      continue;
    }
    const comp = storage.componentByName.get(name);
    if (comp === undefined) {
      throw new Error(errorUnknownComponent(name));
    }
    rejectRelation(comp, "link");
    if (!storage.optionalBitLookup.has(comp)) {
      throw new Error(errorNotOptional(name));
    }
    RESOLVED_COMPS[n] = comp;
    RESOLVED_VALUES[n] = typeof values === "boolean" ? undefined : values;
    n += 1;
  }
  return n;
}

function resolvedEnableBits(storage: Storage, resolvedN: number): number {
  let bits = 0;
  for (let k = 0; k < resolvedN; k++) {
    // oxlint-disable-next-line typescript/no-non-null-assertion -- k < resolvedN; comp validated at resolve time
    bits |= storage.optionalBitLookup.get(RESOLVED_COMPS[k]!)!;
  }
  return bits;
}

/**
 * Applies all pre-resolved enable overrides on a single dense index: one
 * combined mask write plus the field patches. No matcher refresh here —
 * callers refresh once afterwards (single row or the whole batch).
 */
function applyResolvedEnables(
  storage: Storage,
  di: number,
  resolvedN: number,
  combinedBits: number,
): void {
  const entityMask = storage.mask;
  // oxlint-disable-next-line typescript/no-non-null-assertion -- di is a valid dense index
  entityMask[di] = entityMask[di]! | combinedBits;
  for (let k = 0; k < resolvedN; k++) {
    const values = RESOLVED_VALUES[k];
    if (values !== undefined) {
      // oxlint-disable-next-line typescript/no-non-null-assertion -- k < resolvedN ≤ RESOLVED_COMPS.length
      const comp = RESOLVED_COMPS[k]!;
      const soa = storage.columns.get(comp);
      if (soa !== undefined) {
        writeFieldOverrides(soa, comp.__ecstatic_fields, di, values);
      }
    }
  }
}

/**
 * Releases the scratch's references to caller-supplied value records once
 * they have been applied, so the module-level array does not pin them
 * between calls. Not needed for RESOLVED_COMPS — descriptors are
 * registry-lifetime — and not a staleness guard: resolveEnableOverrides
 * rewrites every slot below `resolvedN` before any read.
 */
function clearResolvedValues(resolvedN: number): void {
  for (let k = 0; k < resolvedN; k++) {
    RESOLVED_VALUES[k] = undefined;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Enable an optional component on an entity.
 *
 * With `values`, writes exactly the listed fields on top of the current slot
 * values (merge); with no values it is a pure bit flip exposing whatever the
 * slot holds — declared defaults on a fresh row, retained values after a
 * `disable`. Idempotent.
 *
 * The record form (`{Shield: {hp: 75}, Stunned: true, Slowed: false}`)
 * enables per entry: `true` resumes, `false` skips, a record enables and
 * patches. It resolves every entry before mutating and applies one combined
 * mask write, so an unknown name or a non-optional component throws with the
 * row unchanged. The world form dispatches by id to the owning storage.
 *
 * @throws If the component is not optional on the archetype
 * @throws If a record key names no component on the archetype
 * @throws If DEBUG and the entity ID is stale
 */
export function enable<S extends Storage, C extends ComponentDescriptor>(
  storage: S,
  id: EntityId,
  comp: CheckOptional<C, AllNames<ArchetypeOfStorage<S>>, OptionalNames<ArchetypeOfStorage<S>>>,
  values?: Partial<ComponentFields<C>>,
): void;
export function enable<S extends Storage>(
  storage: S,
  id: EntityId,
  overrides: OptionalOverridesFor<ArchetypeOfStorage<S>> & { readonly __ecstatic_name?: never },
): void;
export function enable(
  world: World,
  id: EntityId,
  comp: ComponentDescriptor,
  values?: Record<string, unknown>,
): void;
export function enable(
  world: World,
  id: EntityId,
  overrides: Record<string, Record<string, unknown> | boolean> & {
    readonly __ecstatic_name?: never;
  },
): void;
// The `| string` third-parameter arm and the widened `values?: object` exist
// only to absorb CheckOptional's sentence-error types and the per-component
// Partial field records for overload compatibility — a string can never
// arrive at runtime (every overload rejects it).
export function enable(
  storageOrWorld: Storage | World,
  id: EntityId,
  compOrRecord: ComponentDescriptor | Record<string, Record<string, unknown> | boolean> | string,
  values?: object,
): void {
  const storage = resolveEntityArch(storageOrWorld, id);
  // oxlint-disable-next-line typescript/no-non-null-assertion -- id validated by resolveEntityArch
  const di = storage.sparse[entityIndex(id)]!;

  if (!isComponentDescriptor(compOrRecord)) {
    // Record form: { Shield: { hp: 75 }, Stunned: true } or { Shield: true }
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the record overloads type this; the impl's `string` arm exists solely for sentence-error types
    const record = compOrRecord as Record<string, Record<string, unknown> | boolean>;
    const resolvedN = resolveEnableOverrides(storage, record);
    const combinedBits = resolvedEnableBits(storage, resolvedN);
    applyResolvedEnables(storage, di, resolvedN, combinedBits);
    BATCH_DENSE_INDICES[0] = di;
    refreshMatchersRows(storage, BATCH_DENSE_INDICES, 1, combinedBits);
    clearResolvedValues(resolvedN);
    return;
  }

  rejectRelation(compOrRecord, "link");
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the overload signatures type values as the component's partial field record
  enableOne(storage, di, compOrRecord, values as Record<string, unknown> | undefined);
}

/**
 * Disable one or more optional components on an entity.
 *
 * Clears the presence bit(s) and touches no data: a later `enable` with no
 * values resumes the retained slot values. The array form applies one
 * combined mask write and pre-validates every element before mutating —
 * an invalid element leaves the mask untouched. Idempotent. The world form
 * dispatches by id to the owning storage.
 *
 * @throws If any component is not optional on the archetype
 * @throws If the array form is given an empty list
 * @throws If DEBUG and the entity ID is stale
 */
export function disable<S extends Storage, C extends ComponentDescriptor>(
  storage: S,
  id: EntityId,
  comp: CheckOptional<C, AllNames<ArchetypeOfStorage<S>>, OptionalNames<ArchetypeOfStorage<S>>>,
): void;
export function disable<
  S extends Storage,
  const Cs extends readonly [ComponentDescriptor, ...ComponentDescriptor[]],
>(
  storage: S,
  id: EntityId,
  comps: [...Cs] &
    CheckOptionalList<AllNames<ArchetypeOfStorage<S>>, OptionalNames<ArchetypeOfStorage<S>>, Cs>,
): void;
export function disable(
  world: World,
  id: EntityId,
  comps: ComponentDescriptor | ComponentDescriptor[],
): void;
// `| string` as in enable: absorbs sentence-error types only.
export function disable(
  storageOrWorld: Storage | World,
  id: EntityId,
  compOrArray: ComponentDescriptor | readonly ComponentDescriptor[] | string,
): void {
  const storage = resolveEntityArch(storageOrWorld, id);
  // oxlint-disable-next-line typescript/no-non-null-assertion -- id validated by resolveEntityArch
  const di = storage.sparse[entityIndex(id)]!;

  if (isComponentDescriptor(compOrArray)) {
    rejectRelation(compOrArray, "unlink");
    disableOne(storage, di, compOrArray);
    return;
  }

  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the public overloads only admit component arrays here; the impl's `string` arm exists solely for sentence-error types
  const comps = compOrArray as readonly ComponentDescriptor[];

  if (comps.length === 0) {
    throw new Error(ERROR_DISABLE_EMPTY);
  }

  const [combinedBit, combinedNotBit] = combineDisableBits(storage, comps);
  applyMaskAnd(storage, di, combinedBit, combinedNotBit);
}

/**
 * Pre-validate `comps` as optionals on the storage and accumulate the
 * combined positive bits plus the combined not-mask — starting from all-ones
 * so AND-ing not-bits progressively clears only the targeted positions.
 * Throws before any mutation.
 */
function combineDisableBits(
  storage: Storage,
  comps: readonly ComponentDescriptor[],
): [combinedBit: number, combinedNotBit: number] {
  let combinedBit = 0;
  let combinedNotBit = 0xff_ff_ff_ff;
  for (const comp of comps) {
    rejectRelation(comp, "unlink");
    const notBit = storage.optionalNotBitLookup.get(comp);
    if (notBit === undefined) {
      throw new Error(errorNotOptional(comp.__ecstatic_name));
    }
    // oxlint-disable-next-line typescript/no-non-null-assertion -- notBit lookup above succeeded, so bit is also present
    combinedBit |= storage.optionalBitLookup.get(comp)!;
    combinedNotBit = (combinedNotBit & notBit) >>> 0;
  }
  return [combinedBit, combinedNotBit];
}

// ---------------------------------------------------------------------------
// Batch toggles
// ---------------------------------------------------------------------------

/**
 * Resolve and validate every listed id (staleness, ownership — DEBUG-gated)
 * before any mutation, caching dense indices in the module scratch so an
 * invalid id throws with zero rows changed.
 */
function resolveBatchIndices(storage: Storage, ids: readonly EntityId[]): void {
  const sparse = storage.sparse;
  for (let k = 0; k < ids.length; k++) {
    // oxlint-disable-next-line typescript/no-non-null-assertion -- k < ids.length
    const eid = ids[k]!;
    validateEntity(storage, eid);
    // oxlint-disable-next-line typescript/no-non-null-assertion -- entity validated; sparse[entityIndex] is populated
    BATCH_DENSE_INDICES[k] = sparse[entityIndex(eid)]!;
  }
}

/**
 * Enable one or more optional components on one or more entities.
 *
 * Two forms:
 * - `enableMany(storage, ids, overrides)` — apply the record grammar to
 *   exactly the listed entities; unlisted entities stay unchanged.
 * - `enableMany(storage, overrides)` — apply to every row via a dense loop
 *   with no per-entity ID resolution.
 *
 * Everything is validated before anything mutates: an unknown name, a
 * non-optional component, or (ids form, DEBUG) a stale/wrong-storage ID
 * throws with zero rows changed. Mixed resume-vs-initialize states across
 * entities behave per-entity. An empty archetype is a graceful no-op.
 */
export function enableMany<S extends Storage>(
  storage: S,
  ids: readonly EntityId[],
  overrides: OptionalOverridesFor<ArchetypeOfStorage<S>> & { readonly __ecstatic_name?: never },
): void;
export function enableMany<S extends Storage>(
  storage: S,
  overrides: OptionalOverridesFor<ArchetypeOfStorage<S>> & { readonly __ecstatic_name?: never },
): void;
export function enableMany(
  storage: Storage,
  second: readonly EntityId[] | Record<string, Record<string, unknown> | boolean>,
  third?: Record<string, Record<string, unknown> | boolean>,
): void {
  let ids: readonly EntityId[] | undefined;
  let overrides: Record<string, Record<string, unknown> | boolean>;
  if (third === undefined) {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the 2-arg overloads type second as the overrides record
    overrides = second as Record<string, Record<string, unknown> | boolean>;
  } else {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the 3-arg overload types second as the id list
    ids = second as readonly EntityId[];
    overrides = third;
  }

  const resolvedN = resolveEnableOverrides(storage, overrides);
  const combinedBits = resolvedEnableBits(storage, resolvedN);

  if (ids === undefined) {
    const n = storage.n;
    for (let di = 0; di < n; di++) {
      applyResolvedEnables(storage, di, resolvedN, combinedBits);
    }
    refreshMatchersAll(storage, combinedBits);
    clearResolvedValues(resolvedN);
    return;
  }

  resolveBatchIndices(storage, ids);
  for (let k = 0; k < ids.length; k++) {
    // oxlint-disable-next-line typescript/no-non-null-assertion -- k < ids.length; resolveBatchIndices populated BATCH_DENSE_INDICES[0..ids.length)
    applyResolvedEnables(storage, BATCH_DENSE_INDICES[k]!, resolvedN, combinedBits);
  }
  refreshMatchersRows(storage, BATCH_DENSE_INDICES, ids.length, combinedBits);
  clearResolvedValues(resolvedN);
}

/**
 * Disable one or more optional components on one or more entities.
 *
 * Two forms:
 * - `disableMany(storage, ids, comps)` — disable on exactly the listed
 *   entities; unlisted entities stay unchanged.
 * - `disableMany(storage, comps)` — disable on every row via a dense loop
 *   with no per-entity ID resolution.
 *
 * Everything is validated before anything mutates: a non-optional component
 * or (ids form, DEBUG) a stale/wrong-storage ID throws with zero rows
 * changed. An empty archetype is a graceful no-op.
 *
 * @throws If given an empty component list
 */
export function disableMany<
  S extends Storage,
  const Cs extends readonly [ComponentDescriptor, ...ComponentDescriptor[]],
>(
  storage: S,
  ids: readonly EntityId[],
  comps: [...Cs] &
    CheckOptionalList<AllNames<ArchetypeOfStorage<S>>, OptionalNames<ArchetypeOfStorage<S>>, Cs>,
): void;
export function disableMany<
  S extends Storage,
  const Cs extends readonly [ComponentDescriptor, ...ComponentDescriptor[]],
>(
  storage: S,
  comps: [...Cs] &
    CheckOptionalList<AllNames<ArchetypeOfStorage<S>>, OptionalNames<ArchetypeOfStorage<S>>, Cs>,
): void;
export function disableMany(
  storage: Storage,
  second: readonly EntityId[] | readonly ComponentDescriptor[],
  third?: readonly ComponentDescriptor[],
): void {
  let ids: readonly EntityId[] | undefined;
  let comps: readonly ComponentDescriptor[];
  if (third === undefined) {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the 2-arg overload types second as the component list
    comps = second as readonly ComponentDescriptor[];
  } else {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the 3-arg overload types second as the id list
    ids = second as readonly EntityId[];
    comps = third;
  }

  if (comps.length === 0) {
    throw new Error(ERROR_DISABLE_MANY_EMPTY);
  }

  const [combinedBit, combinedNotBit] = combineDisableBits(storage, comps);

  const entityMask = storage.mask;
  if (ids === undefined) {
    const n = storage.n;
    for (let di = 0; di < n; di++) {
      // oxlint-disable-next-line typescript/no-non-null-assertion -- di < n; entityMask is capacity-sized
      entityMask[di] = entityMask[di]! & combinedNotBit;
    }
    refreshMatchersAll(storage, combinedBit);
    return;
  }

  resolveBatchIndices(storage, ids);
  for (let k = 0; k < ids.length; k++) {
    // oxlint-disable-next-line typescript/no-non-null-assertion -- k < ids.length; resolveBatchIndices populated BATCH_DENSE_INDICES[0..ids.length)
    const di = BATCH_DENSE_INDICES[k]!;
    // oxlint-disable-next-line typescript/no-non-null-assertion -- di is a valid dense index
    entityMask[di] = entityMask[di]! & combinedNotBit;
  }
  refreshMatchersRows(storage, BATCH_DENSE_INDICES, ids.length, combinedBit);
}
