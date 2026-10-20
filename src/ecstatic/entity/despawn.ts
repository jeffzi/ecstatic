/**
 * Entity despawning: remove entities from storage via swap-and-pop.
 *
 * Two overloads:
 * - `despawn(storage, id)` — despawn from a specific storage (direct).
 * - `despawn(world, id)` — resolve storage from entityArch (world form).
 *
 * Despawning a stale ID (already despawned or reused) is a defined no-op, never an error.
 *
 * Bulk despawning via despawnMany:
 * - `despawnMany(storage)` — despawn all entities from storage.
 * - `despawnMany(storage, ids)` — despawn specific entities; errors on duplicate live id.
 * - `despawnMany(world)` — despawn all entities from all storages.
 * - `despawnMany(world, ids)` — despawn across storages; silently skips duplicate ids.
 *
 * Module-level scratch arrays reused across calls (no allocation per call).
 * Reentrancy note: ids must be a plain array, not a Set, so duplicates can be detected.
 */

import { DEBUG } from "../debug.js";
import type { EntityId } from "../entity-id.js";
import { entityIndex, initialEntityId, MAX_GEN, MAX_INDEX } from "../entity-id.js";
import { ERROR_WRONG_STORAGE } from "../errors.js";
import type { Storage, WorldState } from "../world.js";
import { reverseRemove } from "./reverse-map.js";

/**
 * Module-level scratch storage for bulk despawn operations.
 * Reused across calls to avoid per-call allocation.
 */
const DESPAWN_LIVE_INDICES: number[] = [];
const DESPAWN_WORLD_BUCKETS: Map<Storage, number[]> = new Map();

/**
 * Source cleanup: remove a dying entity from every target's reverse bucket.
 * Must run before swap-and-pop while the row's relation data is still at
 * `row`. Reads the pre-computed parallel arrays (no per-component lookups);
 * a 0 target means "never linked / unlinked" and needs no removal.
 *
 * @param storage - Storage owning the dying row; its relation target columns are read.
 * @param row - Dense row of the dying entity, still holding its relation data.
 * @param index - Entity index of the dying entity, the key removed from each target's bucket.
 */
function relationSourceCleanup(storage: Storage, row: number, index: number): void {
  const relCols = storage.relationTargetColumns;
  const relDescriptors = storage.relationDescriptors;
  const reverseMap = storage.world.reverseMap;
  for (let ri = 0; ri < storage.relationN; ri++) {
    // oxlint-disable-next-line typescript/no-non-null-assertion -- ri < storage.relationN ≤ relCols.length
    const targetCol = relCols[ri]!;
    // oxlint-disable-next-line typescript/no-non-null-assertion -- row < storage.n ≤ targetCol.length
    const targetId = targetCol[row]!;
    if (targetId !== 0) {
      // oxlint-disable-next-line typescript/no-non-null-assertion -- ri < storage.relationN ≤ relDescriptors.length
      reverseRemove(reverseMap, relDescriptors[ri]!, entityIndex(targetId), index);
    }
  }
}

/**
 * Target cleanup: drop every reverse bucket keyed by a dying entity's index.
 * The watermark test rejects most entities (anything never targeted, and
 * every entity in relation-free worlds) before touching the relation list.
 *
 * @param world - World whose reverse map is pruned; nothing is read when it has no relations.
 * @param index - Entity index of the dying entity; above `world.maxTargetIndex` it was never a
 *   target and nothing is touched.
 */
function relationTargetCleanup(world: WorldState, index: number): void {
  if (index <= world.maxTargetIndex) {
    const reverseMap = world.reverseMap;
    for (const rel of world.relations) {
      // oxlint-disable-next-line typescript/no-non-null-assertion -- rel registered in reverseMap at world init
      reverseMap.get(rel)!.delete(index);
    }
  }
}

/**
 * Bulk target cleanup: for each world relation, delete every dying entity's
 * index from the reverse map. Indices above the `world.maxTargetIndex`
 * watermark were never targeted and are skipped without a map lookup.
 *
 * @param world - World whose reverse map is pruned; returns immediately when it has no relations.
 * @param count - Number of dying entities, i.e. the range `[0, count)` passed to `getIndex`.
 * @param getIndex - Resolves the k-th dying entity's entity index; called once per entity per
 *   relation, so it must be cheap and side-effect free.
 */
function bulkTargetCleanup(
  world: WorldState,
  count: number,
  getIndex: (k: number) => number,
): void {
  if (world.relations.length === 0) return;
  const maxTarget = world.maxTargetIndex;
  for (const rel of world.relations) {
    // oxlint-disable-next-line typescript/no-non-null-assertion -- rel registered in reverseMap at world init
    const relMap = world.reverseMap.get(rel)!;
    for (let k = 0; k < count; k++) {
      const index = getIndex(k);
      if (index > maxTarget) continue;
      relMap.delete(index);
    }
  }
}

/**
 * Compute the generation-table entry of a slot being freed.
 *
 * The entry is the slot's next id, which no caller holds yet, so no held id matches the free
 * slot. The one exception is the wrap: generation 1 was issued before, so that entry is stored
 * negated, and no entity id is negative. Spawn negates it back when it takes the slot.
 *
 * @param packedId - The packed id of the entity leaving the slot
 *   (`index + generation × MAX_INDEX`); positive.
 * @param index - The slot's entity index, used to rebuild the id when the generation wraps.
 * @returns The packed id of the slot's next generation, negated when that generation wrapped
 *   to 1; never equal to `packedId`.
 */
function freeSlotEntry(packedId: number, index: number): number {
  const nextGen = packedId + MAX_INDEX;
  return nextGen >= MAX_GEN * MAX_INDEX ? -(initialEntityId(index) as number) : nextGen;
}

/**
 * Phases 2–3 of the ids-form despawn: freed-slot fill compaction, tail clear,
 * then generation advance + freelist push for every marked index (each freed
 * slot's generation-table entry becomes its next id, negated at the wrap).
 *
 * Requires phase 1 to have cleared `entityArch` for each marked index (the
 * "freed" mark) while `sparse` still holds each freed entity's dense row.
 *
 * Compaction is O(count): each freed slot at or below the final boundary gets
 * a survivor popped off the tail. Invariant: while fills remain, an unmoved
 * survivor sits above the boundary, so the pop scan stops at it and never
 * walks onto an already-filled slot — reaching the boundary means the
 * invariant is broken, and erroring beats an unbounded scan.
 *
 * @param storage - Storage being compacted; `n` drops by `count` and its freed tail is cleared.
 * @param indices - Scratch array of marked entity indices; only `[0, count)` is read.
 * @param count - Number of marked indices; at most `storage.n`.
 * @throws If the compaction invariant is violated (a fill finds no survivor above the boundary)
 */
function compactAndFreeMarked(storage: Storage, indices: number[], count: number): void {
  const world = storage.world;
  const n = storage.n;
  const boundary = n - count;

  // Relation cleanup must precede compaction: the source pass reads each
  // dying row's target columns through `sparse`, which the fill overwrites.
  if (storage.relationN > 0) {
    const sparse = world.sparse;
    for (let k = 0; k < count; k++) {
      // oxlint-disable-next-line typescript/no-non-null-assertion -- k < count ≤ indices.length
      const index = indices[k]!;
      // oxlint-disable-next-line typescript/no-non-null-assertion -- index is a live entity index
      relationSourceCleanup(storage, sparse[index]!, index);
    }
  }
  // Target cleanup: relations-outer with the watermark hoisted, so the
  // per-relation bucket map is fetched once per relation, not per entity.
  // oxlint-disable-next-line typescript/no-non-null-assertion -- k < count ≤ indices.length
  bulkTargetCleanup(world, count, (k) => indices[k]!);

  if (boundary !== 0) {
    fillFreedSlots(storage, indices, count, boundary);
  }
  storage.n = boundary;
  clearFreedTail(storage, n, boundary);

  const generation = world.generation;
  const sparse = world.sparse;
  let freeHead = world.freeHead;
  for (let k = 0; k < count; k++) {
    // oxlint-disable-next-line typescript/no-non-null-assertion -- k < count ≤ indices.length
    const index = indices[k]!;
    // oxlint-disable-next-line typescript/no-non-null-assertion -- index is a live entity index
    generation[index] = freeSlotEntry(generation[index]!, index);
    sparse[index] = freeHead;
    freeHead = index;
  }
  world.freeHead = freeHead;
}

/**
 * Freed-slot fill: each marked slot at or below the final boundary receives a
 * survivor popped off the tail (a slot is freed iff its entity's back-pointer
 * was cleared in phase 1).
 *
 * @param storage - Storage being compacted; rows, mask, columns, and matched flags move in place.
 * @param indices - Scratch array of freed entity indices; only `[0, count)` is read.
 * @param count - Number of freed indices.
 * @param boundary - Final row count after compaction; freed rows below it receive a survivor.
 * @throws If the survivor scan reaches the boundary, meaning the compaction invariant is broken
 */
// Compaction hot path: the survivor scan, column copies, and matched-flag
// carry must stay in one loop body — extracting them would split the
// per-slot invariant across functions.
// fallow-ignore-next-line complexity
function fillFreedSlots(
  storage: Storage,
  indices: number[],
  count: number,
  boundary: number,
): void {
  const world = storage.world;
  const sparse = world.sparse;
  const entityArch = world.entityArch;
  const entities = storage.entities;
  let last = storage.n - 1;

  for (let k = 0; k < count; k++) {
    // oxlint-disable-next-line typescript/no-non-null-assertion -- k < count ≤ indices.length
    const idx = indices[k]!;
    // oxlint-disable-next-line typescript/no-non-null-assertion -- idx is a live entity index
    const di = sparse[idx]!;
    if (di < boundary) {
      // Bounded scan: legitimate stops are always at a survivor at or above
      // the boundary; walking past it means the invariant is broken, and
      // erroring beats an unbounded scan.
      // oxlint-disable-next-line typescript/no-non-null-assertion -- last < entities.length
      while (last >= boundary && entityArch[entityIndex(entities[last]!)] === undefined) {
        last -= 1;
      }
      if (last < boundary) {
        throw new Error("despawnMany: compaction invariant violated");
      }
      // oxlint-disable-next-line typescript/no-non-null-assertion -- last ≥ boundary (checked above)
      entities[di] = entities[last]!;
      for (const col of storage.flatColumns) {
        col[di] = col[last];
      }
      // oxlint-disable-next-line typescript/no-non-null-assertion -- last is a valid dense index
      storage.mask[di] = storage.mask[last]!;
      for (const matched of storage.matcherMatched) {
        // oxlint-disable-next-line typescript/no-non-null-assertion -- last is a valid dense index
        matched[di] = matched[last]!;
      }
      sparse[entityIndex(entities[di])] = di;
      last -= 1;
    }
  }
}

/**
 * Clears ref-marked columns over [compactedN, oldN) so despawned rows stop
 * pinning their referents.
 *
 * @param storage - Storage whose `despawnClear` columns are cleared; a no-op when it has none.
 * @param oldN - Row count before despawning (exclusive end of the cleared range).
 * @param compactedN - Row count after despawning (start of the cleared range).
 */
function clearFreedTail(storage: Storage, oldN: number, compactedN: number): void {
  if (storage.hasDespawnClear) {
    for (const col of storage.despawnClear) {
      for (let i = compactedN; i < oldN; i++) {
        col[i] = undefined;
      }
    }
  }
}

/**
 * Despawn from storage (direct form).
 *
 * @param storage - Storage the entity was spawned into; its row is removed by swap-and-pop.
 * @param id - Generational entity id; a stale id (already despawned or reused) is a no-op,
 *   never an error.
 * @throws If DEBUG and the live entity belongs to another storage of the same world
 */
export function despawn(storage: Storage, id: EntityId): void;

/**
 * Despawn from world (world form).
 *
 * @param world - World that owns the entity; the storage is resolved from its `entityArch`.
 * @param id - Generational entity id; a stale id (already despawned or reused) is a no-op,
 *   never an error.
 */
export function despawn(world: WorldState, id: EntityId): void;

export function despawn(storageOrWorld: Storage | WorldState, id: EntityId): void {
  const index = entityIndex(id);

  // Stale entity check: if generation[index] !== id, this entity was already
  // despawned or the index was reused. Either way, no-op (never an error).
  if (storageOrWorld.generation[index] !== id) {
    return;
  }

  const storage = isStorage(storageOrWorld) ? storageOrWorld : storageOrWorld.entityArch[index];

  if (storage === undefined) {
    // World form: stale or no storage at index — already no-op'd by generation check above.
    return;
  }

  if (DEBUG && isStorage(storageOrWorld) && storageOrWorld.world.entityArch[index] !== storage) {
    throw new Error(ERROR_WRONG_STORAGE);
  }

  despawnEntity(storage, index);
}

function isStorage(obj: unknown): obj is Storage {
  return (
    obj !== null &&
    typeof obj === "object" &&
    "n" in obj &&
    "sparse" in obj &&
    "entities" in obj &&
    "world" in obj
  );
}

/**
 * Despawn all entities from storage (storage form, no ids).
 *
 * @param storage - Storage emptied in one pass: every row is freed, `n` drops to 0, and the
 *   generation of every freed index advances so outstanding ids go stale.
 */
export function despawnMany(storage: Storage): void;

/**
 * Despawn specific entities from storage (storage form, with ids).
 *
 * The whole list is validated before any row is despawned: on a duplicate the world is left
 * intact and a retry with a corrected list succeeds.
 *
 * @param storage - Storage every listed live entity must belong to.
 * @param ids - Entity ids to despawn; a stale id (already despawned or reused) is skipped as a
 *   no-op, never an error, but a live id listed twice throws. Must be a plain array, not a Set,
 *   so duplicates are visible.
 * @throws If a live entity id appears more than once in `ids`
 * @throws If DEBUG and a live entity belongs to another storage
 * @throws If the compaction invariant is violated (a fill finds no survivor above the boundary)
 */
export function despawnMany(storage: Storage, ids: EntityId[]): void;

/**
 * Despawn all entities from all storages in a world (world form, no ids).
 *
 * @param world - World emptied storage by storage; its relation reverse map is rebuilt empty
 *   and `maxTargetIndex` reset.
 */
export function despawnMany(world: WorldState): void;

/**
 * Despawn specific entities across all storages in a world (world form, with ids).
 *
 * @param world - World the ids belong to; each live id is routed to its owning storage.
 * @param ids - Entity ids to despawn; a stale id (already despawned or reused) is skipped as a
 *   no-op, never an error, and — unlike the storage form — a live id listed twice is silently
 *   skipped too.
 * @throws If the compaction invariant is violated (a fill finds no survivor above the boundary)
 */
export function despawnMany(world: WorldState, ids: EntityId[]): void;

export function despawnMany(storageOrWorld: Storage | WorldState, ids?: EntityId[]): void {
  if (isStorage(storageOrWorld)) {
    if (ids === undefined) {
      despawnManyStorageNoIds(storageOrWorld);
    } else {
      despawnManyStorageWithIds(storageOrWorld, ids);
    }
  } else {
    if (ids === undefined) {
      despawnManyWorldNoIds(storageOrWorld);
    } else {
      despawnManyWorldWithIds(storageOrWorld, ids);
    }
  }
}

/**
 * Despawn all entities from storage (no ids form).
 * Clears storage.n to 0, advances generations for all entities (each freed slot's
 * generation-table entry becomes its next id, negated at the wrap), and releases despawnClear
 * columns.
 *
 * @param storage - Storage to empty; its rows are pushed onto the world freelist in row order.
 */
function despawnManyStorageNoIds(storage: Storage): void {
  const oldN = storage.n;
  const world = storage.world;
  const generation = world.generation;
  let freeHead = world.freeHead;

  // Relation cleanup must precede the free loop below, which overwrites the
  // sparse links the reverse map is keyed against.
  if (storage.relationN > 0) {
    for (let row = 0; row < oldN; row++) {
      // oxlint-disable-next-line typescript/no-non-null-assertion -- row < oldN ≤ entities.length
      relationSourceCleanup(storage, row, entityIndex(storage.entities[row]!));
    }
  }
  // Target cleanup runs even for relation-free storages — a dying entity may
  // be the target of relations on OTHER archetypes.
  const entities = storage.entities;
  // oxlint-disable-next-line typescript/no-non-null-assertion -- row < oldN ≤ entities.length
  bulkTargetCleanup(world, oldN, (row) => entityIndex(entities[row]!));

  for (let row = 0; row < oldN; row++) {
    // oxlint-disable-next-line typescript/no-non-null-assertion -- row < oldN ≤ entities.length
    const index = entityIndex(storage.entities[row]!);
    // oxlint-disable-next-line typescript/no-non-null-assertion -- index is a live entity index
    generation[index] = freeSlotEntry(generation[index]!, index);
    storage.sparse[index] = freeHead;
    freeHead = index;
    world.entityArch[index] = undefined;
  }
  world.freeHead = freeHead;
  storage.n = 0;
  clearFreedTail(storage, oldN, 0);
}

/**
 * Despawn specific entities from storage (with ids form).
 * Three-phase: resolve+mark, compact, free.
 *
 * On error (duplicate live id), restores all back-pointers so a retry can succeed.
 *
 * @param storage - Storage every listed live entity must belong to.
 * @param ids - Entity ids to despawn; a stale id is skipped, a live id listed twice throws.
 * @throws If a live entity id appears more than once in `ids`
 * @throws If DEBUG and a live entity belongs to another storage
 * @throws If the compaction invariant is violated (propagated from compaction)
 */
function despawnManyStorageWithIds(storage: Storage, ids: EntityId[]): void {
  const world = storage.world;
  const generation = world.generation;
  const entityArch = world.entityArch;
  let validCount = 0;

  // Restore already-cleared back-pointers so a retry with a fixed list works.
  const restoreAndThrow = (message: string): never => {
    for (let k = 0; k < validCount; k++) {
      // oxlint-disable-next-line typescript/no-non-null-assertion -- k < validCount ≤ DESPAWN_LIVE_INDICES.length
      entityArch[DESPAWN_LIVE_INDICES[k]!] = storage;
    }
    throw new Error(message);
  };

  // Phase 1: resolve ids, cache entity indices, and clear each entity's
  // back-pointer as the "freed" mark. A duplicate id still passes the
  // generation check (generations bump in phase 3) but sees the cleared mark.
  for (const id of ids) {
    const index = entityIndex(id);
    if (generation[index] !== id) {
      continue; // stale: silently skip
    }
    if (entityArch[index] === undefined) {
      restoreAndThrow("duplicate entity ID in despawnMany");
    }
    if (DEBUG && entityArch[index] !== storage) {
      restoreAndThrow(ERROR_WRONG_STORAGE);
    }
    entityArch[index] = undefined;
    DESPAWN_LIVE_INDICES[validCount] = index;
    validCount += 1;
  }

  if (validCount !== 0) {
    compactAndFreeMarked(storage, DESPAWN_LIVE_INDICES, validCount);
  }
}

/**
 * Despawn all entities from all storages in a world.
 *
 * @param world - World to empty; every storage is cleared and the relation reverse map is
 *   rebuilt with an empty bucket map per registered relation.
 */
function despawnManyWorldNoIds(world: WorldState): void {
  for (const storage of world.storages.values()) {
    despawnManyStorageNoIds(storage);
  }
  // Rebuild the reverse map from scratch: no live targets remain. The
  // per-relation entries must be re-created — link/reverseInsert index them
  // unguarded (registration pre-initializes them; a bare wipe would leave
  // them missing and crash the next link). The target-index bound resets too.
  const reverseMap = world.reverseMap;
  reverseMap.clear();
  for (const rel of world.relations) {
    reverseMap.set(rel, new Map());
  }
  world.maxTargetIndex = -1;
}

/**
 * Despawn specific entities across all storages in a world.
 *
 * @param world - World the ids belong to; live ids are bucketed per owning storage, then each
 *   bucket is compacted in one pass.
 * @param ids - Entity ids to despawn; stale ids and duplicate live ids are skipped without error.
 * @throws If the compaction invariant is violated (propagated from compaction)
 */
function despawnManyWorldWithIds(world: WorldState, ids: EntityId[]): void {
  // Partition pass: group live entity indices into per-storage buckets,
  // clearing each back-pointer as the "freed" mark — a duplicate id sees the
  // cleared mark via entityArch and is skipped (silent-skip contract, unlike
  // the storage form's duplicate error).
  for (const id of ids) {
    const index = entityIndex(id);
    if (world.generation[index] !== id) {
      continue;
    }
    const storage = world.entityArch[index];
    if (storage === undefined) {
      continue; // duplicate in this call: already marked
    }

    let bucket = DESPAWN_WORLD_BUCKETS.get(storage);
    if (bucket === undefined) {
      bucket = [];
      DESPAWN_WORLD_BUCKETS.set(storage, bucket);
    }
    world.entityArch[index] = undefined;
    bucket.push(index);
  }

  // Run the shared compaction per touched storage, then drop the storage
  // references so storages of destroyed worlds are not retained.
  for (const [storage, indices] of DESPAWN_WORLD_BUCKETS) {
    compactAndFreeMarked(storage, indices, indices.length);
  }
  DESPAWN_WORLD_BUCKETS.clear();
}

function despawnEntity(storage: Storage, index: number): void {
  // oxlint-disable-next-line typescript/no-non-null-assertion -- index is a live entity index
  const row = storage.sparse[index]!;
  const last = storage.n - 1;

  // Relation cleanup must precede swap-and-pop: the source pass reads the
  // dying row's target columns at `row`.
  if (storage.relationN > 0) {
    relationSourceCleanup(storage, row, index);
  }
  relationTargetCleanup(storage.world, index);

  if (row !== last) {
    // oxlint-disable-next-line typescript/no-non-null-assertion -- last < storage.n ≤ entities.length
    storage.entities[row] = storage.entities[last]!;

    for (const col of storage.flatColumns) {
      col[row] = col[last];
    }

    // oxlint-disable-next-line typescript/no-non-null-assertion -- last is a valid dense index
    storage.mask[row] = storage.mask[last]!;
    if (storage.matchers.length !== 0) {
      for (const matched of storage.matcherMatched) {
        // oxlint-disable-next-line typescript/no-non-null-assertion -- last is a valid dense index
        matched[row] = matched[last]!;
      }
    }

    // oxlint-disable-next-line typescript/no-non-null-assertion -- last < storage.n; row was swapped from last
    const lastEntityId = storage.entities[last]!;
    const swappedIndex = entityIndex(lastEntityId);
    storage.sparse[swappedIndex] = row;
  }

  storage.n = last;

  // Clear the freed tail slot (ref-marked columns for GC)
  if (storage.hasDespawnClear) {
    for (const col of storage.despawnClear) {
      col[last] = undefined;
    }
  }

  storage.world.entityArch[index] = undefined;

  // oxlint-disable-next-line typescript/no-non-null-assertion -- index is a live entity index
  storage.generation[index] = freeSlotEntry(storage.generation[index]!, index);

  // Push the index onto the LIFO freelist: the dead sparse slot holds the next pointer
  const world = storage.world;
  storage.sparse[index] = world.freeHead;
  world.freeHead = index;
}
