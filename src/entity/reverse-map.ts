/**
 * Reverse relation index maintenance.
 *
 * Structure: `world.reverseMap[rel][targetIndex] = Map<sourceIndex, Storage>`.
 * The bucket value is the source's storage — reverse iteration reads it
 * directly instead of resolving an archetype id through `world.storages`, and
 * insert/remove skip a whole per-archetype descent level.
 */

import type { ComponentDescriptor } from "../component.js";
import type { Storage, WorldState } from "../world.js";

/**
 * Sentinel key inside a relation's reverse map holding the single-storage
 * flag. Entity indices are 0-based, so -1 can never collide with a real target
 * index; do not change it to a non-negative key.
 */
export const SINGLE_STORAGE_KEY = -1;

/** Bucket of sources linked to one target index: source index → source storage. */
export type SourceBucket = Map<number, Storage>;

/**
 * Per-relation reverse index. Keys ≥ 0 are target indices holding
 * {@link SourceBucket}s; {@link SINGLE_STORAGE_KEY} holds the single-storage
 * flag (`Storage` while a single storage has ever sourced the relation,
 * `false` once sources span multiple storages).
 */
export type RelationReverseMap = Map<number, SourceBucket | Storage | false>;

/**
 * Look up the source bucket recorded for a target index.
 *
 * The `instanceof` check both narrows away the flag-value union members and
 * covers the missing-key case.
 *
 * @param relMap - One relation's reverse map, as stored under
 *   `world.reverseMap`.
 * @param targetIndex - Entity index (not the generational id) of the target.
 * @returns The live bucket, whose mutations are visible through the map, or
 *   `undefined` when no source has ever linked to this target index since
 *   the map was last reset; removal leaves empty buckets in place.
 */
export function sourceBucket(
  relMap: RelationReverseMap,
  targetIndex: number,
): SourceBucket | undefined {
  const bucket = relMap.get(targetIndex);
  return bucket instanceof Map ? bucket : undefined;
}

/**
 * Read the relation's single-storage flag.
 *
 * @param relMap - One relation's reverse map, as stored under
 *   `world.reverseMap`.
 * @returns The sole source storage while one storage has ever sourced the
 *   relation, `false` once sources span multiple storages, `undefined` before
 *   the first insert.
 */
export function soleStorage(relMap: RelationReverseMap): Storage | false | undefined {
  const flag = relMap.get(SINGLE_STORAGE_KEY);
  return flag instanceof Map ? undefined : flag;
}

export interface ReverseCtx {
  state: WorldState;
  rel: ComponentDescriptor;
}

/**
 * Insert a source entity index into the reverse map for a relation.
 * The per-target bucket is lazily created; the top-level `rel` entry is
 * pre-initialized at registration time.
 *
 * Raises `world.maxTargetIndex` when a target index gets its first reverse
 * entry. The update lives in the lazy-create branch, so the steady-state
 * insert path (bucket already exists) pays nothing. Despawn relies on the
 * invariant that any index above `maxTargetIndex` has no reverse entry: it
 * skips the target-side cleanup for such entities.
 *
 * Single-storage flag: the {@link SINGLE_STORAGE_KEY} slot holds the sole
 * storage that has EVER sourced this relation in this world, degraded to
 * `false` once sources span multiple storages. The filtered querySources path
 * reads it once per call to resolve the matcher outside the loop — keeping
 * the per-element loop compare-free for the overwhelmingly common
 * single-source-archetype case. Never re-promoted from `false` (conservative
 * — target/source removal cannot make it lie), never cleaned up; a full
 * reverse-map reset drops it with the map.
 *
 * @param ctx - World state and the relation whose reverse map receives the
 *   entry; the relation must already be registered in that world.
 * @param targetIndex - Entity index of the link target.
 * @param storage - Storage owning the source entity, stored as the bucket
 *   value so reverse iteration skips an archetype lookup.
 * @param sourceIndex - Entity index of the source; an existing entry for it
 *   is overwritten, so re-linking to the same target is idempotent.
 */
export function reverseInsert(
  ctx: ReverseCtx,
  targetIndex: number,
  storage: Storage,
  sourceIndex: number,
): void {
  const { state, rel } = ctx;
  const relMap = state.reverseMap.get(rel);
  /* istanbul ignore next */
  if (relMap === undefined) throw new Error("invariant: relation not registered");

  const sole = relMap.get(SINGLE_STORAGE_KEY);
  if (sole !== storage) {
    if (sole === undefined) {
      relMap.set(SINGLE_STORAGE_KEY, storage);
    } else {
      relMap.set(SINGLE_STORAGE_KEY, false);
    }
  }

  let targetMap = sourceBucket(relMap, targetIndex);
  if (targetMap === undefined) {
    targetMap = new Map();
    relMap.set(targetIndex, targetMap);
    if (targetIndex > state.maxTargetIndex) {
      state.maxTargetIndex = targetIndex;
    }
  }

  targetMap.set(sourceIndex, storage);
}

/**
 * Remove a source entity index from the reverse map for a relation.
 * O(1) hash deletion. Does not drop empty target buckets.
 * The top-level `rel` entry is pre-initialized at registration time.
 *
 * @param reverseMap - The world's relation → reverse-map table.
 * @param rel - Relation whose entry to drop; must be registered in this
 *   world.
 * @param targetIndex - Entity index of the target whose bucket holds the
 *   source; a target with no bucket is a no-op.
 * @param sourceIndex - Entity index of the source to drop; a source not in
 *   the bucket is a no-op.
 */
export function reverseRemove(
  reverseMap: Map<ComponentDescriptor, RelationReverseMap>,
  rel: ComponentDescriptor,
  targetIndex: number,
  sourceIndex: number,
): void {
  const relMap = reverseMap.get(rel);
  /* istanbul ignore next */
  if (relMap === undefined) throw new Error("invariant: relation not registered");
  const targetMap = sourceBucket(relMap, targetIndex);
  if (targetMap !== undefined) {
    targetMap.delete(sourceIndex);
  }
}
