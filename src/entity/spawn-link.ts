/**
 * Relation birth-link helpers for spawn: validate relation targets before
 * allocation and record reverse-map entries after the row is committed.
 *
 * Every function here is internal to the spawn path and not part of the
 * public API.
 */

import type { ComponentDescriptor } from "../component.js";
import { entityIndex } from "../entity-id.js";
import {
  errorOptionalRelationTarget,
  errorRequiredRelationTarget,
  errorStaleTarget,
} from "../errors.js";
import type { SoAColumns, Storage, WorldState } from "../world.js";
import { reverseInsert } from "./reverse-map.js";
import type { SpawnOverrides } from "./spawn.js";

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
 *
 * @param storage - Storage being spawned into; its `relationDescriptors`
 *   drive the checks, so a storage with no relations is a no-op.
 * @param overrides - The spawn's per-component override record, or
 *   `undefined` for a default spawn; each relation is read by name.
 * @throws If a required relation's override has no `target`, or names the 0
 *   sentinel.
 * @throws If an optional relation's override names the 0 sentinel as target.
 * @throws If a relation's target is not alive in the storage's world.
 */
export function assertRelationTargets(
  storage: Storage,
  overrides: SpawnOverrides | undefined,
): void {
  const relN = storage.relationN;
  for (let ri = 0; ri < relN; ri++) {
    // oxlint-disable-next-line typescript/no-non-null-assertion -- ri < relN ≤ relationDescriptors.length
    const name = storage.relationDescriptors[ri]!.__ecstatic_name;
    const optional = storage.relationOptionalBits[ri] !== 0;
    assertRelationTarget(storage.world, name, optional, overrides?.[name]);
  }
}

/**
 * Validate one relation's spawn override value against the birth-link grammar.
 *
 * @param state - World whose generation table decides target liveness.
 * @param name - Relation name, used only in error messages.
 * @param optional - Whether the relation is optional on the archetype; an
 *   optional relation may omit the birth link, a required one must name a
 *   target.
 * @param raw - The relation's override as the caller wrote it: `undefined`
 *   or `true` (no birth link), `false` (stay unlinked; a required relation's
 *   rejection is owned by `resolveRequiredOverride`), or a record whose
 *   `target` is the link target.
 * @throws If a required relation has no target.
 * @throws If the target is the 0 sentinel.
 * @throws If the target id's generation does not match the world's, i.e. the
 *   target is dead or its index has been recycled.
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

  const rawTarget = raw === undefined || raw === true ? undefined : raw["target"];
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
 * Write an optional relation's birth-link target into the target column for a
 * run of freshly spawned rows. Targets are pre-validated by
 * `assertRelationTargets`, so this write path never throws — see that function
 * before adding a check here.
 *
 * @param soa - The relation's column record on the storage; only its `target`
 *   column is written.
 * @param rawTarget - Target entity id from the override; 0 (reachable only
 *   under NDEBUG, where it is unvalidated) writes nothing, leaving the sentinel
 *   in place so the rows spawn unlinked.
 * @param denseStart - Dense index of the first new row.
 * @param count - Number of consecutive new rows from `denseStart`.
 * @returns The target entity id written to every row of the run, or 0 when
 *   the rows were left unlinked.
 */
export function writeBirthTargets(
  soa: SoAColumns,
  rawTarget: unknown,
  denseStart: number,
  count: number,
): number {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- override targets are EntityIds (branded numbers)
  const target = rawTarget as number;
  if (target === 0) {
    return 0;
  }
  // oxlint-disable-next-line typescript/no-non-null-assertion -- relation SoA always has a target column
  const targetCol = soa["target"]!;
  for (let i = 0; i < count; i++) {
    targetCol[denseStart + i] = target;
  }
  return target;
}

/**
 * Record the reverse-map entries of an optional relation's birth link for the
 * freshly spawned rows at the tail of a storage.
 *
 * Spawn appends rows, so the run being linked always ends at `storage.n`; the
 * row count is read from there. A caller linking rows that are not the
 * storage's tail must not use this function.
 *
 * @param storage - Storage the rows were spawned into, with `n` already
 *   advanced past them and every row holding its entity id.
 * @param rel - The optional relation being linked; keys the reverse map.
 * @param target - Target entity id shared by the run, as returned by
 *   {@link writeBirthTargets}; 0 records nothing.
 * @param denseStart - Dense index of the first new row; rows from here up to
 *   `storage.n` are recorded.
 */
export function insertOptionalRelationEntries(
  storage: Storage,
  rel: ComponentDescriptor,
  target: number,
  denseStart: number,
): void {
  if (target === 0) {
    return;
  }
  const targetIdx = entityIndex(target);
  const denseEnd = storage.n;
  for (let di = denseStart; di < denseEnd; di++) {
    // oxlint-disable-next-line typescript/no-non-null-assertion -- di is a freshly spawned dense index
    reverseInsert(rel, targetIdx, storage, entityIndex(storage.entities[di]!));
  }
}

/**
 * Record reverse-map entries for the required relations of a run of freshly
 * spawned rows, reading targets from the already-initialized target columns.
 *
 * Target presence (0 = not provided) and liveness are validated by
 * `assertRelationTargets` before the row exists — a stale target would seed a
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
