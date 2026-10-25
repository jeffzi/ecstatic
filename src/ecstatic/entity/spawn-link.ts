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
  errorRequiredRelationTarget,
  errorStaleTarget,
} from "../errors.js";
import type { Storage, WorldState } from "../world.js";
import { reverseInsert } from "./reverse-map.js";
import type { SpawnOverrides } from "./spawn.js";

/**
 * Optional-relation birth-link targets held between {@link readBirthTargets}
 * and {@link linkOptionalRelations}; 0 means "leave unlinked". A stack: each
 * read reserves `relationN` slots above `birthTop`, so a getter that spawns
 * while its caller's overrides are being read takes the slots above the
 * caller's and never overwrites them. Reused across spawns, so the hot path
 * allocates nothing once it has reached its deepest nesting.
 */
const birthTargets: number[] = [];
let birthTop = 0;

/**
 * Read every relation birth-link target in `overrides` before a row exists,
 * validating each in checked mode, and hold the optional relations' targets
 * for {@link linkOptionalRelations}.
 *
 * Each optional relation's `target` is read exactly once per spawn: the value
 * validated here is the value linked, so a getter cannot pass validation with
 * one entity and link another. Under NDEBUG the required relations are not
 * read here; `initComponentFields` reads their targets.
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
 * Every call must be paired with one {@link linkOptionalRelations} on the same
 * storage, with no user code run between the two: the pair pushes and pops
 * `relationN` slots. A throw from here releases the slots before propagating.
 *
 * @param storage - Storage being spawned into; its `relationDescriptors`
 *   drive the reads, and a storage with no relations reserves nothing.
 * @param overrides - The spawn's per-component override record, or
 *   `undefined` for a default spawn; each relation is read by name.
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
  const relN = storage.relationN;
  birthTop = base + relN;
  try {
    for (let ri = 0; ri < relN; ri++) {
      birthTargets[base + ri] = readBirthTarget(storage, ri, overrides);
    }
  } catch (error) {
    birthTop = base;
    throw error;
  }
}

/**
 * Read one relation's birth-link target, validating it in checked mode.
 *
 * @param storage - Storage being spawned into.
 * @param ri - Index of the relation in `relationDescriptors`.
 * @param overrides - The spawn's per-component override record, or
 *   `undefined` for a default spawn.
 * @returns The optional relation's target entity id, read once from its
 *   override; 0 when it stays unlinked and for every required relation.
 * @throws (checked mode) If the target breaks the birth-link grammar; see
 *   {@link assertRelationTarget}.
 * @throws Whatever a getter on `overrides` or on the relation override throws.
 */
function readBirthTarget(
  storage: Storage,
  ri: number,
  overrides: SpawnOverrides | undefined,
): number {
  const optional = storage.relationOptionalBits[ri] !== 0;
  if (!DEBUG && !optional) {
    return 0;
  }
  // oxlint-disable-next-line typescript/no-non-null-assertion -- ri < relN ≤ relationDescriptors.length
  const name = storage.relationDescriptors[ri]!.__ecstatic_name;
  const raw = overrides?.[name];
  // `false` on an optional relation means "stay unlinked"; on a required one
  // resolveRequiredOverride owns the "cannot be disabled" error.
  if (raw === false) {
    return 0;
  }
  const rawTarget = raw === undefined || raw === true ? undefined : raw["target"];
  if (DEBUG) {
    assertRelationTarget(storage.world, name, optional, rawTarget);
  }
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- override targets are EntityIds (branded numbers)
  return optional && rawTarget !== undefined ? (rawTarget as number) : 0;
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
 * Birth-link a run of freshly spawned rows to the optional-relation targets
 * {@link readBirthTargets} held for this spawn, and release their slots.
 *
 * Writes each linked relation's target column and records its reverse-map
 * entries. Targets were validated when they were read, so this write path
 * never throws — see {@link readBirthTargets} before adding a check here. A
 * held 0 (an unlinked relation, or under NDEBUG an unvalidated 0 target)
 * writes nothing, leaving the sentinel `writeOptionalDefaults` put in place.
 *
 * @param storage - Storage the rows were spawned into; every row in the run
 *   must already hold its entity id, and `writeOptionalDefaults` must already
 *   have run so it does not overwrite the targets written here.
 * @param denseStart - Dense index of the first new row.
 * @param count - Number of consecutive new rows from `denseStart`.
 */
export function linkOptionalRelations(storage: Storage, denseStart: number, count: number): void {
  const relN = storage.relationN;
  const base = birthTop - relN;
  birthTop = base;
  for (let ri = 0; ri < relN; ri++) {
    // oxlint-disable-next-line typescript/no-non-null-assertion -- readBirthTargets filled every slot below the old top
    const target = birthTargets[base + ri]!;
    if (target === 0) {
      continue;
    }
    // oxlint-disable-next-line typescript/no-non-null-assertion -- ri < relN ≤ relationTargetColumns.length
    const targetCol = storage.relationTargetColumns[ri]!;
    // oxlint-disable-next-line typescript/no-non-null-assertion -- ri < relN ≤ relationDescriptors.length
    const rel = storage.relationDescriptors[ri]!;
    const targetIdx = entityIndex(target);
    for (let di = denseStart; di < denseStart + count; di++) {
      targetCol[di] = target;
      // oxlint-disable-next-line typescript/no-non-null-assertion -- di is a freshly spawned dense index
      reverseInsert(rel, targetIdx, storage, entityIndex(storage.entities[di]!));
    }
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
