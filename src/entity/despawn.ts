/**
 * Entity despawning: remove entities from storage via swap-and-pop.
 *
 * Two overloads:
 * - `despawn(storage, id)` — despawn from a specific storage (direct).
 * - `despawn(world, id)` — resolve storage from entityArch (world form).
 *
 * Despawning a stale ID (already despawned or reused) is a defined no-op, never an error.
 */

import { DEBUG } from "../debug.js";
import type { EntityId } from "../entity-id.js";
import { entityIndex, initialEntityId, MAX_GEN, MAX_INDEX } from "../entity-id.js";
import { ERROR_WRONG_STORAGE } from "../errors.js";
import type { Storage, WorldState } from "../world.js";

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

  // Dispatch: if it's a Storage, use it directly; otherwise resolve from world's entityArch.
  const storage = isStorage(storageOrWorld) ? storageOrWorld : storageOrWorld.entityArch[index];

  if (!storage) {
    // World form: stale or no storage at index — already no-op'd by generation check above.
    return;
  }

  // DEBUG check: entity must belong to this storage (direct form only)
  if (DEBUG && isStorage(storageOrWorld) && storageOrWorld.world.entityArch[index] !== storage) {
    throw new Error(ERROR_WRONG_STORAGE);
  }

  // Swap-and-pop: remove entity at sparse[index] from dense storage
  despawnEntity(storage, index);
}

/**
 * Type guard: distinguish Storage from WorldState.
 */
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
 * Core despawn logic: swap entity at row with last, update indices, clear tail.
 */
function despawnEntity(storage: Storage, index: number): void {
  const row = storage.sparse[index]!;
  const last = storage.n - 1;

  // Swap-and-pop: move last entity into the freed row (if not despawning the last)
  if (row !== last) {
    // Copy the last entity's ID into the freed row
    storage.entities[row] = storage.entities[last]!;

    // Copy all component data from last row into freed row
    for (const col of storage.flatColumns) {
      col[row] = col[last];
    }

    // Update the mask (optional component bits)
    storage.mask[row] = storage.mask[last]!;

    // Recover the swapped entity's index and update its sparse lookup
    const lastEntityId = storage.entities[last]!;
    const swappedIndex = lastEntityId % MAX_INDEX;
    storage.sparse[swappedIndex] = row;
  }

  // Decrement count
  storage.n = last;

  // Clear the freed tail slot (ref-marked columns for GC)
  if (storage.hasDespawnClear) {
    for (const col of storage.despawnClear) {
      col[last] = undefined;
    }
  }

  // Free the index: invalidate entityArch and advance generation with wrap
  storage.world.entityArch[index] = undefined;

  const nextGen = storage.generation[index]! + MAX_INDEX;
  // Check for generation overflow: if nextGen >= MAX_GEN * MAX_INDEX, wrap to gen 1
  if (nextGen >= MAX_GEN * MAX_INDEX) {
    storage.generation[index] = initialEntityId(index);
  } else {
    storage.generation[index] = nextGen;
  }

  // Push the index onto the LIFO freelist: the dead sparse slot holds the next pointer
  const world = storage.world;
  storage.sparse[index] = world.freeHead;
  world.freeHead = index;
}
