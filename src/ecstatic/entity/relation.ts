/**
 * Relation link mutators: `link` attaches or retargets an entity's relation,
 * `unlink` detaches an optional relation. Together with spawn's birth-link
 * and despawn's cleanup they are the only writers of the target column and
 * the world's reverse map.
 */

import type { ComponentDescriptor } from "../component.js";
import { DEBUG } from "../debug.js";
import type { EntityId, With } from "../entity-id.js";
import { entityIndex } from "../entity-id.js";
import {
  ERROR_RELATION_NOT_ON_ARCHETYPE,
  errorStaleTarget,
  errorUnlinkRequired,
} from "../errors.js";
import { applyMaskOr } from "../matcher.js";
import type { Relation, RelationConstraints, RelationFields } from "../relation.js";
import type { SoAColumns, Storage, World } from "../world.js";
import { resolveEntityArch } from "./common.js";
import { writeFieldOverrides } from "./field-write.js";
import { disableOne } from "./optional.js";
import { reverseInsert, reverseRemove } from "./reverse-map.js";

/**
 * Remove a source's entry from its previous target's reverse bucket, when that
 * target is still alive. A dead previous target needs no removal — despawn
 * already cleaned its bucket.
 *
 * @param world - World that owns the source; its generation table decides the
 *   previous target's liveness and its reverse map loses the entry.
 * @param rel - Relation whose reverse map holds the entry.
 * @param prevTarget - Target id read from the source's row of the relation's
 *   target column before it is overwritten; the 0 sentinel ("no target") and
 *   `undefined` are skipped.
 * @param sourceIndex - Entity index of the source whose reverse entry is
 *   removed.
 */
function removePreviousTarget(
  world: World,
  rel: ComponentDescriptor,
  prevTarget: number | undefined,
  sourceIndex: number,
): void {
  if (prevTarget !== undefined && prevTarget !== 0) {
    const prevTargetIndex = entityIndex(prevTarget);
    if (world.generation[prevTargetIndex] === prevTarget) {
      reverseRemove(world.reverseMap, rel, prevTargetIndex, sourceIndex);
    }
  }
}

/**
 * Resolve a relation's column record on a storage.
 *
 * @param storage - Storage whose archetype must declare `rel` as a required
 *   or optional relation.
 * @param rel - Relation whose columns to resolve.
 * @returns The relation's column record. Growth swaps new arrays into this
 *   same record, so {@link targetColumnOf} read after a getter runs still
 *   returns the live target column.
 * @throws If the archetype does not carry the relation.
 */
function resolveRelationColumns(storage: Storage, rel: ComponentDescriptor): SoAColumns {
  const soa = storage.columns.get(rel);
  if (soa === undefined || !(soa["target"] instanceof Float64Array)) {
    throw new Error(ERROR_RELATION_NOT_ON_ARCHETYPE);
  }
  return soa;
}

/**
 * The target column currently in a relation's column record.
 *
 * @param soa - A column record returned by {@link resolveRelationColumns}.
 * @returns The live target column, indexed by dense row.
 */
function targetColumnOf(soa: SoAColumns): Float64Array {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- resolveRelationColumns checked the column is a Float64Array; growth replaces it with one of the same type
  return soa["target"] as Float64Array;
}

/**
 * Link an entity to a target entity via a relation.
 *
 * For required relations: writes the data fields (the relation is always
 * present). For optional relations: enables the relation (sets the presence
 * bit, refreshing matchers) and writes data fields. Either way the previous
 * target's reverse entry (if any, and alive) is removed, the target column
 * is written, and the source lands in the new target's reverse bucket.
 *
 * @param world - World that owns both entities; the source's storage is
 *   resolved from it, so any live id in the world is accepted.
 * @param id - Source entity id; its archetype must carry `rel`.
 * @param rel - Relation to write; a required relation only takes new data, an
 *   optional one is also enabled.
 * @param target - Target entity id, type-checked against the relation's
 *   constraints; a stale target is rejected only under DEBUG.
 * @param values - Data fields to overwrite, stored by reference without
 *   cloning; omitted fields keep their current column values. Every field is
 *   read once, and the link is written after the last read, so a getter that
 *   grows the storage or moves the source still has the link land in the
 *   source's current row.
 * @throws If the relation is not on the entity's archetype
 * @throws If DEBUG and the source or target ID is stale, checked again after
 *   the getters on `values` run
 * @throws Whatever a getter on `values` throws; the data fields before it
 *   are already written, and the link itself is left unchanged
 */
/* oxlint-disable max-params -- public API: link overloads */
export function link<R extends Relation>(
  world: World,
  id: EntityId,
  rel: R,
  target: With<RelationConstraints<R>>,
  values?: Partial<RelationFields<R>>,
): void;
export function link(
  world: World,
  id: EntityId,
  rel: ComponentDescriptor,
  target: EntityId,
  values?: object,
): void {
  /* oxlint-enable max-params */
  const sourceIndex = entityIndex(id);
  const storage = resolveEntityArch(world, id);

  const targetIndex = entityIndex(target);
  if (DEBUG && world.generation[targetIndex] !== target) {
    throw new Error(errorStaleTarget(rel.__ecstatic_name));
  }
  const relColumns = resolveRelationColumns(storage, rel);

  if (values !== undefined) {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the public overload types values as the relation's partial field record
    writeFieldOverrides(storage, id, rel, values as Record<string, unknown>);
    // The getters may have despawned the target, grown the storage (replacing the target
    // column), or moved the source to another row.
    if (DEBUG && world.generation[targetIndex] !== target) {
      throw new Error(errorStaleTarget(rel.__ecstatic_name));
    }
  }
  const targetColumn = targetColumnOf(relColumns);
  const di = storage.sparse[sourceIndex];
  /* istanbul ignore next */
  if (di === undefined) throw new Error("invariant: entity missing from sparse array");

  removePreviousTarget(world, rel, targetColumn[di], sourceIndex);
  const optionalBit = storage.optionalBitLookup.get(rel);
  if (optionalBit !== undefined) {
    applyMaskOr(storage, di, optionalBit);
  }
  targetColumn[di] = target;
  reverseInsert(rel, targetIndex, storage, sourceIndex);
}

/**
 * Unlink an entity from its target via an optional relation: removes the
 * reverse entry (when the previous target is alive), clears the target
 * column to the 0 sentinel, and clears the presence bit (refreshing
 * matchers). Unlinking an already-unlinked optional relation is a no-op.
 *
 * @param world - World that owns the entity; the source's storage is resolved
 *   from it, so any live id in the world is accepted.
 * @param id - Source entity id, validated for staleness only under DEBUG.
 * @param rel - Optional relation to detach; a required relation cannot be
 *   unlinked.
 * @throws If the relation is not on the entity's archetype
 * @throws If the relation is required on the archetype
 * @throws If DEBUG and the source ID is stale
 */
export function unlink(world: World, id: EntityId, rel: Relation): void;
export function unlink(world: World, id: EntityId, rel: ComponentDescriptor): void {
  const sourceIndex = entityIndex(id);
  const storage = resolveEntityArch(world, id);
  const di = storage.sparse[sourceIndex];
  /* istanbul ignore next */
  if (di === undefined) throw new Error("invariant: entity missing from sparse array");

  const targetColumn = targetColumnOf(resolveRelationColumns(storage, rel));

  const optionalBit = storage.optionalBitLookup.get(rel);
  if (optionalBit === undefined) {
    throw new Error(errorUnlinkRequired(rel.__ecstatic_name));
  }

  removePreviousTarget(world, rel, targetColumn[di], sourceIndex);

  targetColumn[di] = 0;
  disableOne(storage, di, rel);
}
