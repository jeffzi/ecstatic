/**
 * Relation birth-link helpers for spawn: read and validate relation targets
 * before allocation and link the rows after they are committed.
 *
 * Every function here is internal to the spawn path and not part of the
 * public API.
 */

import type { ComponentDescriptor } from "../component.js";
import { DEBUG } from "../debug.js";
import { entityIndex } from "../entity-id.js";
import {
  errorOptionalRelationTarget,
  errorRequiredDisabled,
  errorRequiredRelationTarget,
  errorStaleTarget,
} from "../errors.js";
import type { SoAColumns, Storage, WorldState } from "../world.js";
import { reverseInsert } from "./reverse-map.js";
import type { SpawnOverrides } from "./spawn.js";

/**
 * Relation birth-link targets held between {@link readBirthTargets} and
 * {@link writeBirthRelations}. A frame holds one target per relation (0 means
 * "leave unlinked", and for a required relation is the target column's 0
 * sentinel), then the OR of the optional relations' presence bits. A stack:
 * each read reserves a frame above `birthTop`, so a getter that spawns while
 * its caller's overrides are being read takes the slots above the caller's and
 * never overwrites them. Reused across spawns, so the hot path allocates
 * nothing once it has reached its deepest nesting.
 */
const birthTargets: number[] = [];
let birthTop = 0;

/**
 * Relation data-field values held alongside {@link birthTargets}: one slot per
 * data field of every relation, in `relationDescriptors` order, holding the
 * value to write — the override, or a required relation's default — or
 * {@link KEEP_FIELD}. Same stack discipline, with its own top; a slot is
 * cleared once written so it never keeps a caller's value alive.
 */
const birthValues: unknown[] = [];
let valuesTop = 0;

/**
 * Held in a `birthValues` slot whose column keeps what is already there: an
 * optional relation's default, or a ref field with no override. A sentinel
 * rather than `undefined`, which a non-ref field may declare as its default.
 */
const KEEP_FIELD: unique symbol = Symbol("keep field");

/**
 * Read every relation override in `overrides` once, before a row exists:
 * each relation's override record, its `target`, and its data fields, held
 * for {@link writeBirthRelations} to write. Validates each target in checked
 * mode.
 *
 * Every relation value the spawn writes is read here exactly once, in both
 * modes: the target validated is the target linked, and a getter cannot pass
 * validation with one entity and link another, nor yield a record on one read
 * and `false` on the next. Reading ahead of the row also means no getter on a
 * relation override can grow the storage under a pending write.
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
 *
 * Every call must be paired with one {@link writeBirthRelations} on the same
 * storage, with no user code run between the two: the pair pushes and pops one
 * frame on each stack. A throw from here releases the frame before
 * propagating.
 *
 * @param storage - Storage being spawned into; its `relationDescriptors`
 *   drive the reads, and a storage with no relations reserves only the
 *   presence-mask slot.
 * @param overrides - The spawn's per-component override record, or
 *   `undefined` for a default spawn; each relation is read by name.
 * @throws If a required relation's override is `false`.
 * @throws (checked mode) If a required relation's override has no `target`,
 *   or names the 0 sentinel.
 * @throws (checked mode) If an optional relation's override names the 0
 *   sentinel as target.
 * @throws (checked mode) If a relation's target is not alive in the storage's
 *   world.
 * @throws Whatever a getter on `overrides` or on a relation override throws.
 */
export function readBirthTargets(storage: Storage, overrides: SpawnOverrides | undefined): void {
  const base = birthTop;
  const valuesBase = valuesTop;
  const relN = storage.relationN;
  birthTop = base + relN + 1;
  valuesTop = valuesBase + relationFieldCount(storage);
  try {
    let presence = 0;
    let vi = valuesBase;
    for (let ri = 0; ri < relN; ri++) {
      // oxlint-disable-next-line typescript/no-non-null-assertion -- ri < relN ≤ relationDescriptors.length
      const rel = storage.relationDescriptors[ri]!;
      const raw = overrides?.[rel.__ecstatic_name];
      // oxlint-disable-next-line typescript/no-non-null-assertion -- ri < relN ≤ relationOptionalBits.length
      const bit = storage.relationOptionalBits[ri]!;
      const optional = bit !== 0;
      birthTargets[base + ri] = readBirthTarget(storage.world, rel.__ecstatic_name, optional, raw);
      holdRelationFields(rel, optional, raw, vi);
      vi += rel.__ecstatic_fields.length;
      if (raw !== undefined && raw !== false) {
        presence |= bit;
      }
    }
    birthTargets[base + relN] = presence;
  } catch (error) {
    birthTop = base;
    valuesTop = valuesBase;
    throw error;
  }
}

/**
 * Read one relation's birth-link target from its already-read override,
 * validating it in checked mode.
 *
 * @param state - World whose generation table decides target liveness.
 * @param name - Relation name, used in error messages.
 * @param optional - Whether the relation is optional on the archetype.
 * @param raw - The relation's override, read once from the spawn's overrides:
 *   a record, `true`, `false`, or `undefined` when absent.
 * @returns The record's `target` as given, or 0 when there is none.
 * @throws If the relation is required and `raw` is `false`.
 * @throws (checked mode) If the target breaks the birth-link grammar; see
 *   {@link assertRelationTarget}.
 * @throws Whatever a getter on the record's `target` throws.
 */
function readBirthTarget(
  state: WorldState,
  name: string,
  optional: boolean,
  raw: SpawnOverrides[string] | undefined,
): number {
  if (raw === false && !optional) {
    throw new Error(errorRequiredDisabled(name));
  }
  const rawTarget = overrideRecord(raw)?.["target"];
  if (DEBUG) {
    assertRelationTarget(state, name, optional, rawTarget);
  }
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- override targets are EntityIds (branded numbers)
  return rawTarget === undefined ? 0 : (rawTarget as number);
}

/**
 * Narrow a relation's spawn override to its field record.
 *
 * @param raw - The relation's override as already read from the spawn's overrides.
 * @returns The override record, or `undefined` for `true`, `false`, or no override.
 */
function overrideRecord(
  raw: SpawnOverrides[string] | undefined,
): Record<string, unknown> | undefined {
  return raw === undefined || typeof raw === "boolean" ? undefined : raw;
}

/**
 * Read one relation's data-field overrides once and hold, per field, the
 * value its column receives at birth.
 *
 * @param rel - The relation whose declared fields are read.
 * @param optional - Whether the relation is optional on the archetype; its
 *   defaults are already in its columns, so a field without an override holds
 *   {@link KEEP_FIELD}, where a required relation's non-ref field holds its
 *   default.
 * @param raw - The relation's override, read once from the spawn's overrides;
 *   only a record carries field values.
 * @param valueStart - First `birthValues` slot of the relation, one per field
 *   in declaration order.
 * @throws Whatever a getter on the record's fields throws.
 */
function holdRelationFields(
  rel: ComponentDescriptor,
  optional: boolean,
  raw: SpawnOverrides[string] | undefined,
  valueStart: number,
): void {
  const record = overrideRecord(raw);
  const fields = rel.__ecstatic_fields;
  for (let fieldIdx = 0; fieldIdx < fields.length; fieldIdx++) {
    // oxlint-disable-next-line typescript/no-non-null-assertion -- fieldIdx < fields.length
    const override = record?.[fields[fieldIdx]!];
    let held: unknown = override;
    if (override === undefined) {
      held =
        optional || rel.__ecstatic_is_reference[fieldIdx] === true
          ? KEEP_FIELD
          : rel.__ecstatic_default_values[fieldIdx];
    }
    birthValues[valueStart + fieldIdx] = held;
  }
}

/**
 * Count the data fields of every relation on a storage — the width of its
 * frame on the `birthValues` stack.
 *
 * @param storage - Storage whose `relationDescriptors` are summed.
 * @returns The total number of declared data fields across its relations.
 */
function relationFieldCount(storage: Storage): number {
  let count = 0;
  const relN = storage.relationN;
  for (let ri = 0; ri < relN; ri++) {
    // oxlint-disable-next-line typescript/no-non-null-assertion -- ri < relN ≤ relationDescriptors.length
    count += storage.relationDescriptors[ri]!.__ecstatic_fields.length;
  }
  return count;
}

/**
 * Validate one relation's birth-link target against the birth-link grammar.
 *
 * @param state - World whose generation table decides target liveness.
 * @param name - Relation name, used only in error messages.
 * @param optional - Whether the relation is optional on the archetype; an
 *   optional relation may omit the birth link, a required one must name a
 *   target.
 * @param rawTarget - The `target` already read from the relation's override
 *   record; `undefined` when the override is absent, `true`, or a record
 *   without a `target`.
 * @throws If a required relation has no target.
 * @throws If the target is the 0 sentinel.
 * @throws If the target id's generation does not match the world's, i.e. the
 *   target is dead or its index has been recycled.
 */
function assertRelationTarget(
  state: WorldState,
  name: string,
  optional: boolean,
  rawTarget: unknown,
): void {
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
 * Write the relation values {@link readBirthTargets} held for this spawn into
 * a run of freshly spawned rows, birth-link the optional relations, and
 * release the frame.
 *
 * Writes every required relation's target column (0 under NDEBUG when no
 * target was given) and data fields — the override value, else the default
 * for a non-ref field — and every linked optional relation's target column,
 * reverse-map entries, and overridden data fields. Targets were validated
 * when they were read, so this write path never throws — see
 * {@link readBirthTargets} before adding a check here. A held 0 on an optional
 * relation (unlinked, or under NDEBUG an unvalidated 0 target) writes no
 * target, leaving the sentinel `writeOptionalDefaults` put in place. Runs no
 * user code: every value it writes was read before allocation.
 *
 * @param storage - Storage the rows were spawned into; every row in the run
 *   must already hold its entity id, and `writeOptionalDefaults` must already
 *   have run so it does not overwrite the values written here.
 * @param denseStart - Dense index of the first new row.
 * @param count - Number of consecutive new rows from `denseStart`.
 * @returns The OR of the presence bits of the optional relations the
 *   overrides enabled; the caller merges it into the rows' mask.
 */
export function writeBirthRelations(storage: Storage, denseStart: number, count: number): number {
  const relN = storage.relationN;
  const base = birthTop - relN - 1;
  const valuesBase = valuesTop - relationFieldCount(storage);
  const denseEnd = denseStart + count;
  birthTop = base;
  valuesTop = valuesBase;
  let vi = valuesBase;
  for (let ri = 0; ri < relN; ri++) {
    // oxlint-disable-next-line typescript/no-non-null-assertion -- readBirthTargets filled every slot of the frame
    const target = birthTargets[base + ri]!;
    // oxlint-disable-next-line typescript/no-non-null-assertion -- ri < relN ≤ relationDescriptors.length
    const rel = storage.relationDescriptors[ri]!;
    const optional = storage.relationOptionalBits[ri] !== 0;
    if (!optional || target !== 0) {
      // oxlint-disable-next-line typescript/no-non-null-assertion -- ri < relN ≤ relationTargetColumns.length
      const targetCol = storage.relationTargetColumns[ri]!;
      for (let di = denseStart; di < denseEnd; di++) {
        targetCol[di] = target;
      }
    }
    if (optional && target !== 0) {
      const targetIdx = entityIndex(target);
      for (let di = denseStart; di < denseEnd; di++) {
        // oxlint-disable-next-line typescript/no-non-null-assertion -- di is a freshly spawned dense index
        reverseInsert(rel, targetIdx, storage, entityIndex(storage.entities[di]!));
      }
    }
    const fields = rel.__ecstatic_fields;
    // oxlint-disable-next-line typescript/no-non-null-assertion -- rel is on the archetype, so columns has it
    const soa = storage.columns.get(rel)!;
    for (let fieldIdx = 0; fieldIdx < fields.length; fieldIdx++) {
      // oxlint-disable-next-line typescript/no-non-null-assertion -- the SoA has a column per declared field
      writeHeldField(soa[fields[fieldIdx]!]!, vi + fieldIdx, denseStart, count);
    }
    vi += fields.length;
  }
  // oxlint-disable-next-line typescript/no-non-null-assertion -- readBirthTargets wrote the frame's presence slot
  return birthTargets[base + relN]!;
}

/**
 * Write one held data-field value into a run of rows, unless it is
 * {@link KEEP_FIELD}, and clear its `birthValues` slot.
 *
 * @param col - The field's column.
 * @param slot - The `birthValues` slot holding the value.
 * @param denseStart - Dense index of the first new row.
 * @param count - Number of consecutive new rows from `denseStart`.
 */
function writeHeldField(
  col: SoAColumns[string],
  slot: number,
  denseStart: number,
  count: number,
): void {
  const value = birthValues[slot];
  birthValues[slot] = undefined;
  if (value === KEEP_FIELD) {
    return;
  }
  for (let di = denseStart; di < denseStart + count; di++) {
    col[di] = value;
  }
}

/**
 * Record reverse-map entries for the required relations of a run of freshly
 * spawned rows, reading targets from the already-initialized target columns.
 *
 * Target presence (0 = not provided) and liveness are validated by
 * `readBirthTargets` before the row exists — a stale target would seed a
 * reverse entry that aliases onto a reused slot. Under NDEBUG both checks are
 * absent: the entity spawns unlinked on a 0 target, and no reverse entry is
 * recorded.
 *
 * @param storage - Storage the rows were spawned into; its parallel
 *   `relationTargetColumns`, `relationDescriptors`, and `relationOptionalBits`
 *   arrays are walked, skipping optional relations.
 * @param denseStart - Dense index of the first new row.
 * @param count - Number of consecutive new rows from `denseStart`.
 */
export function insertRequiredRelationEntries(
  storage: Storage,
  denseStart: number,
  count: number,
): void {
  const relCols = storage.relationTargetColumns;
  const relDescriptors = storage.relationDescriptors;
  const relBits = storage.relationOptionalBits;
  const relN = storage.relationN;

  for (let ri = 0; ri < relN; ri++) {
    if (relBits[ri] !== 0) {
      continue;
    }
    // oxlint-disable-next-line typescript/no-non-null-assertion -- ri < relN ≤ relCols.length
    const col = relCols[ri]!;
    // oxlint-disable-next-line typescript/no-non-null-assertion -- ri < relN ≤ relDescriptors.length
    const relDesc = relDescriptors[ri]!;
    for (let i = 0; i < count; i++) {
      const di = denseStart + i;
      // oxlint-disable-next-line typescript/no-non-null-assertion -- di is a freshly spawned dense index
      insertRequiredEntry(storage, relDesc, col[di]!, di);
    }
  }
}

/**
 * Record one required-relation birth entry in the reverse map.
 *
 * @param storage - Storage owning the source entity; its world's reverse map
 *   receives the entry.
 * @param rel - The required relation being recorded.
 * @param target - Target entity id read from the target column; 0 means "not
 *   provided", reachable only under NDEBUG, and leaves the entity unlinked
 *   with no reverse entry.
 * @param di - Dense row of the source entity; must already hold its entity
 *   id.
 */
function insertRequiredEntry(
  storage: Storage,
  rel: ComponentDescriptor,
  target: number,
  di: number,
): void {
  if (target === 0) {
    return;
  }
  // oxlint-disable-next-line typescript/no-non-null-assertion -- di is a freshly spawned dense index
  reverseInsert(rel, entityIndex(target), storage, entityIndex(storage.entities[di]!));
}
