/**
 * Common entity operations: staleness checks and field override handling.
 */

import { DEBUG } from "../debug.js";
import type { EntityId } from "../entity-id.js";
import { entityIndex } from "../entity-id.js";
import { ERROR_STALE_ENTITY_ID, ERROR_WRONG_STORAGE } from "../errors.js";
import type { Storage, WorldState } from "../world.js";

/**
 * Check if an entity ID is alive (valid and not despawned) in a storage or world.
 *
 * Works across storages in the same world: the entity is alive in that world
 * regardless of which storage is queried (as long as the storage is from the same world).
 *
 * @param storageOrWorld - A Storage (or World with generation array alias)
 * @param id - The entity ID to check
 * @returns true if the entity ID is valid and matches the current generation, false otherwise
 */
export function alive(
  storageOrWorld: Storage | { generation: Float64Array },
  id: EntityId,
): boolean {
  const index = entityIndex(id);
  return storageOrWorld.generation[index] === id;
}

/**
 * Validate that an entity ID is alive and belongs to the given storage (under DEBUG).
 * Called by get/set before accessing fields.
 *
 * @param storage - The storage to validate against
 * @param id - The entity ID to check
 * @throws If DEBUG and the ID is stale
 * @throws If DEBUG and the storage doesn't match the entity's world
 */
export function validateEntity(storage: Storage, id: EntityId): void {
  if (!DEBUG) return;

  const index = entityIndex(id);

  // Check staleness: generation must match
  if (storage.generation[index] !== id) {
    throw new Error(ERROR_STALE_ENTITY_ID);
  }

  // Check wrong storage: entityArch[index] must be the storage or compatible
  if (storage.world.entityArch[index] !== storage) {
    throw new Error(ERROR_WRONG_STORAGE);
  }
}

/**
 * Resolve the storage for an entity given either a Storage or World.
 * For Storage: validates staleness, then returns it.
 * For World: returns the storage from entityArch[index].
 *
 * @param storageOrWorld - A Storage or WorldState (disguised as {world} backref)
 * @param id - The entity ID
 * @returns The resolved storage
 * @throws If DEBUG and ID is stale or wrong storage
 */
export function resolveEntityArch(storageOrWorld: Storage | WorldState, id: EntityId): Storage {
  // A Storage carries a `world` backref; a WorldState does not
  if ("world" in storageOrWorld) {
    validateEntity(storageOrWorld, id);
    return storageOrWorld;
  }

  const index = entityIndex(id);
  if (DEBUG && storageOrWorld.generation[index] !== id) {
    throw new Error(ERROR_STALE_ENTITY_ID);
  }

  // DEBUG's stale check guarantees the slot is occupied; under NDEBUG a
  // stale ID is the caller's bug (same contract as the spawn/despawn hot paths)
  return storageOrWorld.entityArch[index]!;
}
