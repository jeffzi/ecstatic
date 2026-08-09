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

/** Message for a required relation spawned without a target (DEBUG-gated). */
export function errorRequiredRelationTarget(name: string): string {
  return `required relation ${name} must receive a target at spawn`;
}

/** Message for a relation target whose generation no longer matches (DEBUG-gated). */
export function errorStaleTarget(name: string): string {
  return `stale target ID for relation ${name}`;
}

/** Message for an optional relation birth-link given target 0 (DEBUG-gated). */
export function errorOptionalRelationTarget(name: string): string {
  return `optional relation ${name} requires a target value`;
}

/** Thrown by link/unlink/getTarget when the entity's archetype lacks the relation. */
export const ERROR_RELATION_NOT_ON_ARCHETYPE = "relation not on this entity's archetype";

/** Thrown by set when a write names a relation's reserved target field. */
export const ERROR_RELATION_TARGET_WRITE =
  "cannot write relation target field — use link() instead";

/** Message for unlinking a relation the archetype declares required. */
export function errorUnlinkRequired(name: string): string {
  return `cannot unlink required relation ${name}`;
}

/** Message for enable/disable given a relation — link/unlink own relation toggles. */
export function errorRelationToggle(name: string, targetOp: "link" | "unlink"): string {
  return `${name} is a relation — use ${targetOp}() instead`;
}
