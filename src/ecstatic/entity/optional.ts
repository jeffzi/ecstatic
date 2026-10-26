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
import { DEBUG } from "../debug.js";
import type { EntityId } from "../entity-id.js";
import { entityIndex } from "../entity-id.js";
import {
  ERROR_DISABLE_EMPTY,
  ERROR_DISABLE_MANY_EMPTY,
  ERROR_STALE_ENTITY_ID,
  errorNotOptional,
  errorRelationToggle,
  errorUnknownComponent,
} from "../errors.js";
import { applyMaskAnd, applyMaskOr, refreshMatchersAll, refreshMatchersRows } from "../matcher.js";
import { getRelationMeta } from "../relation.js";
import type { FieldColumn, Storage, World } from "../world.js";
import { resolveEntityArch, validateEntity } from "./common.js";
import { writeColumnValues, writeFieldOverrides, writeRowValues } from "./field-write.js";
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

/**
 * Reject relation components in enable/disable operations — link/unlink own them.
 *
 * @param comp - Component about to be toggled; a non-relation component passes through untouched.
 * @param targetOp - The relation operation the error message points the caller to instead.
 * @throws If `comp` is a relation component
 */
function rejectRelation(comp: ComponentDescriptor, targetOp: "link" | "unlink"): void {
  const rel = getRelationMeta(comp);
  if (rel !== undefined) {
    throw new Error(errorRelationToggle(rel.__ecstatic_name, targetOp));
  }
}

/**
 * Look up an optional component's presence bit.
 *
 * @param storage - Storage whose archetype declares the optionals.
 * @param comp - Component to look up.
 * @returns The component's presence bit.
 * @throws If `comp` is not optional on the archetype
 */
function optionalBit(storage: Storage, comp: ComponentDescriptor): number {
  const bit = storage.optionalBitLookup.get(comp);
  if (bit === undefined) {
    throw new Error(errorNotOptional(comp.__ecstatic_name));
  }
  return bit;
}

/**
 * Enable one optional component on a single dense row.
 *
 * @param storage - Storage owning the row; its mask and matcher caches are updated in place.
 * @param di - Dense row to enable on, as resolved before the call.
 * @param comp - Component to enable; must be an optional of the storage's archetype.
 * @param values - Fields to patch, each read once, before the presence bit is set; `undefined`
 *   is a pure bit flip exposing whatever the slot holds. Ignored for tag components, which have
 *   no columns. A getter that moves the entity sends the writes to its new row.
 * @throws If `comp` is not optional on the archetype, before any value is read
 * @throws If DEBUG and a getter on `values` despawned the entity
 * @throws Whatever a getter on `values` throws; the fields before it are already written and the
 *   presence bit is unchanged
 */
export function enableOne(
  storage: Storage,
  di: number,
  comp: ComponentDescriptor,
  values?: Record<string, unknown>,
): void {
  const bit = optionalBit(storage, comp);
  if (values === undefined) {
    applyMaskOr(storage, di, bit);
    return;
  }
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion, typescript/no-non-null-assertion -- di is a live dense row; entities holds packed ids
  const id = storage.entities[di]! as EntityId;
  writeFieldOverrides(storage, id, comp, values);
  // oxlint-disable-next-line typescript/no-non-null-assertion -- the entity is alive, so its sparse slot is populated
  applyMaskOr(storage, storage.sparse[entityIndex(id)]!, bit);
}

/**
 * Disable one optional component on a single dense row.
 *
 * @param storage - Storage owning the row; its mask and matcher caches are updated in place.
 * @param di - Dense row to disable on.
 * @param comp - Component to disable; must be an optional of the storage's archetype. Its slot
 *   data is left intact, so a later `enableOne` with no values resumes the retained values.
 * @throws If `comp` is not optional on the archetype
 */
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
// resolved (comp, values) override list and the per-id dense indices. The
// resolved list is a stack with `resolvedTop` as its first free entry, so an
// enable run by a getter while a caller's values are read resolves above the
// caller's entries and releases back to them.
const RESOLVED_COMPS: ComponentDescriptor[] = [];
const RESOLVED_VALUES: (Record<string, unknown> | undefined)[] = [];
// Each resolved values record's field columns, looked up once per call rather than once per row.
const RESOLVED_COLUMNS: (readonly FieldColumn[] | undefined)[] = [];
let resolvedTop = 0;
const BATCH_DENSE_INDICES: number[] = [];

/**
 * Resolve all (name → comp, values) pairs up front so an unknown name or a
 * non-optional component errors before any mutation and before any field
 * value is read. `false` entries are filtered out here so they never enter the
 * per-entity loops.
 *
 * The entries are pushed onto the module scratch stacks, from the
 * `resolvedTop` captured before the call up to the new `resolvedTop`;
 * {@link releaseResolved} drops them, and a throw from here drops the ones
 * already pushed.
 *
 * @param storage - Storage whose archetype resolves each name and whose optional set validates it.
 * @param overrides - Record grammar: a field record or `true` enables the entry, `false` skips it.
 * @returns The combined presence bits of every resolved component.
 * @throws If a key names no component on the archetype
 * @throws If a key names a relation component
 * @throws If a key names a component that is not optional on the archetype
 * @throws Whatever a getter on `overrides` throws
 */
function resolveEnableOverrides(
  storage: Storage,
  overrides: Record<string, Record<string, unknown> | boolean>,
): number {
  const base = resolvedTop;
  let bits = 0;
  try {
    for (const [name, values] of Object.entries(overrides)) {
      if (values === false) {
        continue;
      }
      const comp = storage.componentByName.get(name);
      if (comp === undefined) {
        throw new Error(errorUnknownComponent(name));
      }
      rejectRelation(comp, "link");
      bits |= optionalBit(storage, comp);
      const record = typeof values === "boolean" ? undefined : values;
      RESOLVED_COMPS[resolvedTop] = comp;
      RESOLVED_VALUES[resolvedTop] = record;
      RESOLVED_COLUMNS[resolvedTop] =
        record === undefined ? undefined : storage.fieldColumns.get(comp);
      resolvedTop += 1;
    }
  } catch (error) {
    releaseResolved(base);
    throw error;
  }
  return bits;
}

/**
 * Whether any resolved entry has field values to write, i.e. whether applying the frame can run
 * user code.
 *
 * @param resolvedBase - First resolved entry of the frame.
 * @returns `true` when at least one entry has a values record and columns to write it to.
 */
function resolvedHasValues(resolvedBase: number): boolean {
  for (let k = resolvedBase; k < resolvedTop; k++) {
    if (RESOLVED_COLUMNS[k] !== undefined) {
      return true;
    }
  }
  return false;
}

/**
 * Write one entity's field values for every resolved entry that carries a values record; see
 * {@link writeColumnValues}.
 *
 * @param storage - Storage the entity lives in.
 * @param id - The entity written.
 * @param resolvedBase - First resolved entry of the frame.
 * @throws If DEBUG and a getter despawned the entity
 * @throws Whatever a getter on a values record throws; the fields before it are already written
 */
function writeResolvedValues(storage: Storage, id: EntityId, resolvedBase: number): void {
  for (let k = resolvedBase; k < resolvedTop; k++) {
    const columns = RESOLVED_COLUMNS[k];
    if (columns !== undefined) {
      // oxlint-disable-next-line typescript/no-non-null-assertion -- an entry with columns has a values record
      writeColumnValues(storage, id, columns, RESOLVED_VALUES[k]!);
    }
  }
}

/**
 * Write one row's field values for every resolved entry that carries a values record, into the
 * row index given; see {@link writeRowValues}.
 *
 * @param resolvedBase - First resolved entry of the frame.
 * @param di - Dense row written.
 * @throws Whatever a getter on a values record throws; the fields before it are already written
 */
function writeResolvedRow(resolvedBase: number, di: number): void {
  for (let k = resolvedBase; k < resolvedTop; k++) {
    const columns = RESOLVED_COLUMNS[k];
    if (columns !== undefined) {
      // oxlint-disable-next-line typescript/no-non-null-assertion -- an entry with columns has a values record
      writeRowValues(columns, RESOLVED_VALUES[k]!, di);
    }
  }
}

/**
 * Drop the resolved entries from `resolvedBase` up, releasing the scratch's
 * references to caller-supplied value records and to the storage's columns so
 * the module-level arrays do not pin them between calls. RESOLVED_COMPS needs
 * no clearing — descriptors are registry-lifetime.
 *
 * @param resolvedBase - The `resolvedTop` captured before `resolveEnableOverrides` ran.
 */
function releaseResolved(resolvedBase: number): void {
  for (let k = resolvedBase; k < resolvedTop; k++) {
    RESOLVED_VALUES[k] = undefined;
    RESOLVED_COLUMNS[k] = undefined;
  }
  resolvedTop = resolvedBase;
}

/**
 * Apply the record form of `enable` to one entity: resolve every entry, write every field
 * value, then set the combined presence bits with one mask write in the entity's current row.
 *
 * @param storage - Storage the entity lives in; its mask, columns, and matcher caches are
 *   updated in place.
 * @param id - Entity to enable on, already validated against `storage`.
 * @param record - Record grammar `{Name: values | true | false}`.
 * @throws If a key names no component on the archetype, a relation, or a non-optional
 *   component; the row is left unchanged
 * @throws If DEBUG and a getter despawned the entity
 * @throws Whatever a getter on `record` or on a values record throws; the fields written before
 *   it stay written and no presence bit is set
 */
function enableRecord(
  storage: Storage,
  id: EntityId,
  record: Record<string, Record<string, unknown> | boolean>,
): void {
  const resolvedBase = resolvedTop;
  const bits = resolveEnableOverrides(storage, record);
  try {
    writeResolvedValues(storage, id, resolvedBase);
  } finally {
    releaseResolved(resolvedBase);
  }
  // oxlint-disable-next-line typescript/no-non-null-assertion -- the entity is alive, so its sparse slot is populated
  const di = storage.sparse[entityIndex(id)]!;
  const entityMask = storage.mask;
  // oxlint-disable-next-line typescript/no-non-null-assertion -- di is a live dense row
  entityMask[di] = entityMask[di]! | bits;
  BATCH_DENSE_INDICES[0] = di;
  refreshMatchersRows(storage, BATCH_DENSE_INDICES, 1, bits);
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
 * @param storage - Storage the entity lives in (storage form), or the world that owns it (world
 *   form, dispatched by id to the owning storage).
 * @param id - Generational id of the entity to enable on.
 * @param comp - Optional component to enable; the record form passes a `{name: values}` record
 *   here instead.
 * @param values - Fields to patch on top of the current slot values; omit for a pure bit flip.
 *   Not accepted by the record form, which carries values per entry.
 * @throws If the component is not optional on the archetype
 * @throws If the component is a relation (link/unlink own relation toggles)
 * @throws If a record key names no component on the archetype
 * @throws If DEBUG and the entity ID is stale
 * @throws If DEBUG and the entity belongs to another storage (storage form)
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

  if (!isComponentDescriptor(compOrRecord)) {
    // Record form: { Shield: { hp: 75 }, Stunned: true } or { Shield: true }
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the record overloads type this; the impl's `string` arm exists solely for sentence-error types
    enableRecord(storage, id, compOrRecord as Record<string, Record<string, unknown> | boolean>);
    return;
  }

  rejectRelation(compOrRecord, "link");
  const bit = optionalBit(storage, compOrRecord);
  if (values !== undefined) {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the overload signatures type values as the component's partial field record
    writeFieldOverrides(storage, id, compOrRecord, values as Record<string, unknown>);
  }
  // oxlint-disable-next-line typescript/no-non-null-assertion -- the entity is alive, so its sparse slot is populated
  applyMaskOr(storage, storage.sparse[entityIndex(id)]!, bit);
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
 * @param storage - Storage the entity lives in (storage form), or the world that owns it (world
 *   form, dispatched by id to the owning storage).
 * @param id - Generational id of the entity to disable on.
 * @param comp - Optional component to disable, or (array form) a non-empty list of them; slot
 *   data is left intact either way.
 * @throws If any component is not optional on the archetype
 * @throws If any component is a relation (link/unlink own relation toggles)
 * @throws If the array form is given an empty list
 * @throws If DEBUG and the entity ID is stale
 * @throws If DEBUG and the entity belongs to another storage (storage form)
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
 *
 * @param storage - Storage whose optional bit tables validate and resolve each component.
 * @param comps - Components to disable; every one must be an optional of the archetype.
 * @returns `[combinedBit, combinedNotBit]`: the OR of the presence bits, and the all-ones mask
 *   with exactly those bits cleared, as an unsigned 32-bit value.
 * @throws If any component is a relation (link/unlink own relation toggles)
 * @throws If any component is not optional on the archetype
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
 *
 * @param storage - Storage every listed id must belong to.
 * @param ids - Entity ids to resolve; their dense rows land in `BATCH_DENSE_INDICES[0, length)`
 *   until the next call overwrites them.
 * @throws If DEBUG and an id is stale
 * @throws If DEBUG and an entity belongs to another storage
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
 * Everything is validated before anything mutates, so a throw leaves zero
 * rows changed. Mixed resume-vs-initialize states across entities behave
 * per-entity. An empty archetype is a graceful no-op.
 *
 * @param storage - Storage the entities live in; its mask, columns, and matcher caches are
 *   updated in place.
 * @param ids - Entities to enable on (ids form); omitted in the all-rows form.
 * @param overrides - Record grammar `{Name: values | true | false}`: a record enables and
 *   patches, `true` resumes, `false` skips the entry.
 * @throws If a key names no component on the archetype
 * @throws If a key names a relation component (link/unlink own relation toggles)
 * @throws If a key names a component that is not optional on the archetype
 * @throws If DEBUG and an id is stale or belongs to another storage (ids form)
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

  const resolvedBase = resolvedTop;
  const bits = resolveEnableOverrides(storage, overrides);
  try {
    if (ids === undefined) {
      enableAllRows(storage, resolvedBase, bits);
    } else {
      enableListedRows(storage, ids, resolvedBase, bits);
    }
  } finally {
    releaseResolved(resolvedBase);
  }
}

/**
 * The all-rows form of `enableMany`: write each row's field values, then set the presence bits
 * on every row and refresh the matchers once. Rows are positional: a getter that despawns or
 * spawns while the values are read does not change which row indices are written.
 *
 * @param storage - Storage whose rows `[0, n)` are enabled, `n` read before any getter runs.
 * @param resolvedBase - First resolved entry of the frame.
 * @param bits - Combined presence bits of the resolved components.
 * @throws Whatever a getter on a values record throws; rows before it keep their written
 *   values, and no presence bit has been set
 */
function enableAllRows(storage: Storage, resolvedBase: number, bits: number): void {
  const n = storage.n;
  if (resolvedHasValues(resolvedBase)) {
    for (let di = 0; di < n; di++) {
      writeResolvedRow(resolvedBase, di);
    }
  }
  const entityMask = storage.mask;
  for (let di = 0; di < n; di++) {
    // oxlint-disable-next-line typescript/no-non-null-assertion -- di < n
    entityMask[di] = entityMask[di]! | bits;
  }
  refreshMatchersAll(storage, bits);
}

/**
 * The ids form of `enableMany`: validate every id, write each entity's field values into its
 * row resolved after its getters run, then set the presence bits on every row, resolved once
 * more since a later getter can move an earlier entity, and refresh the matchers once.
 *
 * @param storage - Storage the entities live in.
 * @param ids - Entities to enable on.
 * @param resolvedBase - First resolved entry of the frame.
 * @param bits - Combined presence bits of the resolved components.
 * @throws If DEBUG and an id is stale or belongs to another storage; no row has been changed
 * @throws If DEBUG and a getter despawned a listed entity
 * @throws Whatever a getter on a values record throws; entities before it keep their written
 *   values, and no presence bit has been set
 */
function enableListedRows(
  storage: Storage,
  ids: readonly EntityId[],
  resolvedBase: number,
  bits: number,
): void {
  if (!resolvedHasValues(resolvedBase)) {
    resolveBatchIndices(storage, ids);
    const entityMask = storage.mask;
    for (let k = 0; k < ids.length; k++) {
      // oxlint-disable-next-line typescript/no-non-null-assertion -- k < ids.length; resolveBatchIndices populated BATCH_DENSE_INDICES[0..ids.length)
      const di = BATCH_DENSE_INDICES[k]!;
      // oxlint-disable-next-line typescript/no-non-null-assertion -- di is a live dense row
      entityMask[di] = entityMask[di]! | bits;
    }
  } else {
    for (const eid of ids) {
      validateEntity(storage, eid);
    }
    for (const eid of ids) {
      writeResolvedValues(storage, eid, resolvedBase);
    }
    // Resolved once no user code is left to run: a later entity's getters can move an earlier
    // one, and growth replaces the mask and the world arrays.
    const entityMask = storage.mask;
    const sparse = storage.sparse;
    const generation = storage.generation;
    for (let k = 0; k < ids.length; k++) {
      // oxlint-disable-next-line typescript/no-non-null-assertion -- k < ids.length
      const eid = ids[k]!;
      const index = entityIndex(eid);
      if (DEBUG && generation[index] !== eid) {
        throw new Error(ERROR_STALE_ENTITY_ID);
      }
      // oxlint-disable-next-line typescript/no-non-null-assertion -- the entity is alive, so its sparse slot is populated
      const di = sparse[index]!;
      BATCH_DENSE_INDICES[k] = di;
      // oxlint-disable-next-line typescript/no-non-null-assertion -- di is a live dense row
      entityMask[di] = entityMask[di]! | bits;
    }
  }
  refreshMatchersRows(storage, BATCH_DENSE_INDICES, ids.length, bits);
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
 * Everything is validated before anything mutates, so a throw leaves zero
 * rows changed. An empty archetype is a graceful no-op.
 *
 * @param storage - Storage the entities live in; its mask and matcher caches are updated in place.
 * @param ids - Entities to disable on (ids form); omitted in the all-rows form.
 * @param comps - Non-empty list of optional components to disable; slot data is left intact.
 * @throws If given an empty component list
 * @throws If any component is a relation (link/unlink own relation toggles)
 * @throws If any component is not optional on the archetype
 * @throws If DEBUG and an id is stale or belongs to another storage (ids form)
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
