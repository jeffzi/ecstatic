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
 * flag. Entity indices are 0-based in this port, so the flag key is -1 (the
 * original used key 0, free only because Lua entity indices start at 1).
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
 * The source bucket for a target index, or `undefined` when none exists.
 * The `instanceof` check both narrows away the flag-value union members and
 * covers the missing-key case.
 */
export function sourceBucket(
  relMap: RelationReverseMap,
  targetIndex: number,
): SourceBucket | undefined {
  const bucket = relMap.get(targetIndex);
  return bucket instanceof Map ? bucket : undefined;
}

/**
 * The relation's single-storage flag: the sole source storage while one
 * storage has ever sourced the relation, `false` once sources span multiple
 * storages, `undefined` before the first insert.
 */
export function soleStorage(relMap: RelationReverseMap): Storage | false | undefined {
  const flag = relMap.get(SINGLE_STORAGE_KEY);
  return flag instanceof Map ? undefined : flag;
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
 */
export function reverseInsert(
  state: WorldState,
  rel: ComponentDescriptor,
  targetIndex: number,
  storage: Storage,
  sourceIndex: number,
): void {
  const relMap = state.reverseMap.get(rel)!;

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
 */
export function reverseRemove(
  reverseMap: Map<ComponentDescriptor, RelationReverseMap>,
  rel: ComponentDescriptor,
  targetIndex: number,
  sourceIndex: number,
): void {
  const targetMap = sourceBucket(reverseMap.get(rel)!, targetIndex);
  if (targetMap !== undefined) {
    targetMap.delete(sourceIndex);
  }
}
