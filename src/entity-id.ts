/**
 * Entity ID encoding (gen-high layout):
 * ```
 * id    = gen * MAX_INDEX + index
 * index = id % MAX_INDEX         (one modulo, no Math.floor)
 * gen   = floor(id / MAX_INDEX)  (cold path only: debug, display)
 * ```
 *
 * Worlds store the full packed ID of each entity in a generation table.
 * Staleness check: `generations[index] === id` (no gen extraction needed).
 * Gen advance on despawn: `generations[index] += MAX_INDEX`.
 * Fresh slot init: `generations[index] = MAX_INDEX + index` (gen=1, skips 0 sentinel).
 */

/** Brand type to distinguish EntityId from raw numbers at the type level. */
export type EntityId = number & { readonly __brand: "EntityId" };

/** Number of bits used for the entity index (low bits). */
const INDEX_BITS = 24;

/** Maximum entity index (exclusive) per world. Also the gen stride. */
export const MAX_INDEX = 2 ** INDEX_BITS;

/**
 * Maximum generation value (exclusive).
 * Remaining safe integer budget after index bits: 2^(53-24) = 2^29.
 */
export const MAX_GEN = 2 ** (53 - INDEX_BITS);

/** Error message used by assertEntityIndex when an index exceeds MAX_INDEX. */
export const OVERFLOW_MSG = `entity index overflow (max ${MAX_INDEX - 1} per world)`;

/** Sentinel for `freeHead`/freelist links meaning "no free slot". */
export const NO_FREE_SLOT = -1;

/**
 * Assert that an entity index is within valid bounds.
 * Throws if index >= MAX_INDEX.
 */
export function assertEntityIndex(index: number): void {
  if (index >= MAX_INDEX) {
    throw new Error(OVERFLOW_MSG);
  }
}

/**
 * Extract the entity index from a packed ID.
 */
export function entityIndex(id: number): number {
  return id % MAX_INDEX;
}

/**
 * Pack a fresh entity ID for a new index slot (gen=1, skipping gen=0 sentinel).
 *
 * Only used when a fresh (never-used) index slot is initialized. Reused slots
 * read the pre-computed ID directly from their generation table entry.
 */
export function initialEntityId(index: number): EntityId {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- branded type boundary
  return (MAX_INDEX + index) as EntityId;
}

/**
 * Extract the generation counter from a packed ID (cold path: debug/display only).
 * Hot paths use full-ID comparison (`generations[index] === id`) instead.
 */
export function entityGen(id: number): number {
  return Math.floor(id / MAX_INDEX);
}
