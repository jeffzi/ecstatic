/**
 * Common entity operations: staleness checks and field override handling.
 */

import type { EntityId } from "../entity-id.js";
import { entityIndex } from "../entity-id.js";
import type { Storage } from "../world.js";

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
