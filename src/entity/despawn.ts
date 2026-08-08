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
 */
function relationSourceCleanup(storage: Storage, row: number, index: number): void {
  const relCols = storage.relationTargetColumns;
  const relDescriptors = storage.relationDescriptors;
  const reverseMap = storage.world.reverseMap;
  for (let ri = 0; ri < storage.relationN; ri++) {
    const targetId = relCols[ri]![row]!;
    if (targetId !== 0) {
      reverseRemove(reverseMap, relDescriptors[ri]!, entityIndex(targetId), index);
    }
  }
}

/**
 * Target cleanup: drop every reverse bucket keyed by a dying entity's index.
 * The watermark test rejects most entities (anything never targeted, and
 * every entity in relation-free worlds) before touching the relation list.
 */
function relationTargetCleanup(world: WorldState, index: number): void {
  if (index <= world.maxTargetIndex) {
    const reverseMap = world.reverseMap;
    for (const rel of world.relations) {
      reverseMap.get(rel)!.delete(index);
    }
  }
}

/**
 * Advance a slot's generation by one (add MAX_INDEX to the packed ID),
 * wrapping to generation 1 when it would reach MAX_GEN.
 */
function nextGeneration(packedId: number, index: number): number {
  const nextGen = packedId + MAX_INDEX;
  return nextGen >= MAX_GEN * MAX_INDEX ? initialEntityId(index) : nextGen;
}

/**
 * Phases 2–3 of the ids-form despawn: freed-slot fill compaction, tail clear,
 * then generation bump + freelist push for every marked index.
 *
 * Requires phase 1 to have cleared `entityArch` for each marked index (the
 * "freed" mark) while `sparse` still holds each freed entity's dense row.
 *
 * Compaction is O(count): each freed slot at or below the final boundary gets
 * a survivor popped off the tail. Invariant: while fills remain, an unmoved
 * survivor sits above the boundary, so the pop scan stops at it and never
 * walks onto an already-filled slot — reaching the boundary means the
 * invariant is broken, and erroring beats an unbounded scan.
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
      const index = indices[k]!;
      relationSourceCleanup(storage, sparse[index]!, index);
    }
  }
  // Target cleanup: relations-outer with the watermark hoisted, so the
  // per-relation bucket map is fetched once per relation, not per entity.
  if (world.relations.length > 0) {
    const maxTarget = world.maxTargetIndex;
    for (const rel of world.relations) {
      const relMap = world.reverseMap.get(rel)!;
      for (let k = 0; k < count; k++) {
        const index = indices[k]!;
        if (index <= maxTarget) {
          relMap.delete(index);
        }
      }
    }
  }

  if (boundary !== 0) {
    fillFreedSlots(storage, indices, count, boundary);
  }
  storage.n = boundary;
  clearFreedTail(storage, n, boundary);

  const generation = world.generation;
  const sparse = world.sparse;
  let freeHead = world.freeHead;
  for (let k = 0; k < count; k++) {
    const index = indices[k]!;
    generation[index] = nextGeneration(generation[index]!, index);
    sparse[index] = freeHead;
    freeHead = index;
  }
  world.freeHead = freeHead;
}

/**
 * Freed-slot fill: each marked slot at or below the final boundary receives a
 * survivor popped off the tail (a slot is freed iff its entity's back-pointer
 * was cleared in phase 1).
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
    const di = sparse[indices[k]!]!;
    if (di < boundary) {
      // Bounded scan: legitimate stops are always at a survivor at or above
      // the boundary; walking past it means the invariant is broken, and
      // erroring beats an unbounded scan.
      while (last >= boundary && entityArch[entityIndex(entities[last]!)] === undefined) {
        last -= 1;
      }
      if (last < boundary) {
        throw new Error("despawnMany: compaction invariant violated");
      }
      entities[di] = entities[last]!;
      for (const col of storage.flatColumns) {
        col[di] = col[last];
      }
      storage.mask[di] = storage.mask[last]!;
      if (storage.matchers.length !== 0) {
        for (const matched of storage.matcherMatched) {
          matched[di] = matched[last]!;
        }
      }
      sparse[entityIndex(entities[di])] = di;
      last -= 1;
    }
  }
}

/**
 * Clears ref-marked columns over [compactedN, oldN) so despawned rows stop
 * pinning their referents.
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
 * Stale entities (generation mismatch) are silently ignored — a defined no-op.
 * Under DEBUG, checks that the entity belongs to this storage.
 *
 * @param storage - The archetype storage
 * @param id - The entity ID to despawn
 *
 * @throws If DEBUG and entity does not belong to this storage
 */
export function despawn(storage: Storage, id: EntityId): void;

/**
 * Despawn from world (world form).
 *
 * Resolves the storage from entityArch[index]. If the entity is stale or
 * does not exist, this is a no-op. Otherwise, delegates to despawn(storage, id).
 *
 * @param world - The world (has generation and entityArch)
 * @param id - The entity ID to despawn
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

  if (!storage) {
    // World form: stale or no storage at index — already no-op'd by generation check above.
    return;
  }

  // DEBUG check: entity must belong to this storage (direct form only)
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
 * Despawn all entities from storage.
 *
 * @param storage - The archetype storage
 */
export function despawnMany(storage: Storage): void;

/**
 * Despawn specific entities from storage.
 *
 * Errors if a live entity ID appears more than once in the list (before despawning),
 * leaving the world intact. Silently skips stale IDs.
 *
 * @param storage - The archetype storage
 * @param ids - Array of entity IDs to despawn
 *
 * @throws If a duplicate live entity ID is found in the list
 */
export function despawnMany(storage: Storage, ids: EntityId[]): void;

/**
 * Despawn all entities from all storages in a world.
 *
 * @param world - The world
 */
export function despawnMany(world: WorldState): void;

/**
 * Despawn specific entities across all storages in a world.
 *
 * Silently skips stale IDs and duplicate IDs (world form contract differs from storage form).
 *
 * @param world - The world
 * @param ids - Array of entity IDs to despawn
 */
export function despawnMany(world: WorldState, ids: EntityId[]): void;

export function despawnMany(storageOrWorld: Storage | WorldState, ids?: EntityId[]): void {
  if (isStorage(storageOrWorld)) {
    if (!ids) {
      despawnManyStorageNoIds(storageOrWorld);
    } else {
      despawnManyStorageWithIds(storageOrWorld, ids);
    }
  } else {
    if (!ids) {
      despawnManyWorldNoIds(storageOrWorld);
    } else {
      despawnManyWorldWithIds(storageOrWorld, ids);
    }
  }
}

/**
 * Despawn all entities from storage (no ids form).
 * Clears storage.n to 0, advances generations for all entities, and releases despawnClear columns.
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
      relationSourceCleanup(storage, row, entityIndex(storage.entities[row]!));
    }
  }
  // Target cleanup runs even for relation-free storages — a dying entity may
  // be the target of relations on OTHER archetypes. Relations-outer with the
  // watermark hoisted: one bucket-map fetch per relation, not per entity.
  if (world.relations.length > 0) {
    const maxTarget = world.maxTargetIndex;
    const reverseMap = world.reverseMap;
    for (const rel of world.relations) {
      const relMap = reverseMap.get(rel)!;
      for (let row = 0; row < oldN; row++) {
        const index = entityIndex(storage.entities[row]!);
        if (index <= maxTarget) {
          relMap.delete(index);
        }
      }
    }
  }

  for (let row = 0; row < oldN; row++) {
    const index = entityIndex(storage.entities[row]!);
    generation[index] = nextGeneration(generation[index]!, index);
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
 * @throws If a duplicate live entity ID is found
 */
function despawnManyStorageWithIds(storage: Storage, ids: EntityId[]): void {
  const world = storage.world;
  const generation = world.generation;
  const entityArch = world.entityArch;
  let validCount = 0;

  // Restore already-cleared back-pointers so a retry with a fixed list works.
  const restoreAndThrow = (message: string): never => {
    for (let k = 0; k < validCount; k++) {
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
 * Silently skips stale IDs and duplicate IDs.
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
  const row = storage.sparse[index]!;
  const last = storage.n - 1;

  // Relation cleanup must precede swap-and-pop: the source pass reads the
  // dying row's target columns at `row`.
  if (storage.relationN > 0) {
    relationSourceCleanup(storage, row, index);
  }
  relationTargetCleanup(storage.world, index);

  if (row !== last) {
    storage.entities[row] = storage.entities[last]!;

    for (const col of storage.flatColumns) {
      col[row] = col[last];
    }

    storage.mask[row] = storage.mask[last]!;
    if (storage.matchers.length !== 0) {
      for (const matched of storage.matcherMatched) {
        matched[row] = matched[last]!;
      }
    }

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

  storage.generation[index] = nextGeneration(storage.generation[index]!, index);

  // Push the index onto the LIFO freelist: the dead sparse slot holds the next pointer
  const world = storage.world;
  storage.sparse[index] = world.freeHead;
  world.freeHead = index;
}
