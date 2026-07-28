/**
 * Error messages for world lifecycle and operations.
 */

/** Thrown by register/getStorage after destroyWorld has been called. */
export const ERROR_WORLD_DESTROYED = "world is destroyed";

/** Thrown when an entity ID is used with a storage that does not own it. */
export const ERROR_WRONG_STORAGE = "entity ID does not belong to this storage";

/** Thrown when an entity ID refers to a despawned entity. */
export const ERROR_STALE_ENTITY_ID = "stale entity ID";
