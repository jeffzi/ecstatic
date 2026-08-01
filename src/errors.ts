/**
 * Error messages for world lifecycle and operations.
 */

/** Thrown by register/getStorage after destroyWorld has been called. */
export const ERROR_WORLD_DESTROYED = "world is destroyed";

/** Thrown when an entity ID is used with a storage that does not own it. */
export const ERROR_WRONG_STORAGE = "entity ID does not belong to this storage";

/** Thrown when an entity ID refers to a despawned entity. */
export const ERROR_STALE_ENTITY_ID = "stale entity ID";

/** Thrown by the array form of disable when given an empty component list. */
export const ERROR_DISABLE_EMPTY = "disable requires at least one component";

/** Thrown by has/hasAny when given an empty component list. */
export const ERROR_OPTIONAL_CHECK_EMPTY =
  "optional component check requires at least one component";

/** Thrown by disableMany when given an empty component list. */
export const ERROR_DISABLE_MANY_EMPTY = "disableMany requires at least one component";

/** Thrown by query when the all axis (or comps array) is empty. */
export const ERROR_QUERY_EMPTY = "query requires at least one component";

/** Message for toggling or checking a component the archetype doesn't declare optional. */
export function errorNotOptional(name: string): string {
  return `component ${name} is not optional on this archetype`;
}

/** Message for a record-form key that names no component on the archetype. */
export function errorUnknownComponent(name: string): string {
  return `unknown component name: ${name}`;
}

/** Message for DEBUG-gated field access on a disabled optional component. */
export function errorNotEnabled(name: string): string {
  return `component ${name} not enabled on entity`;
}
