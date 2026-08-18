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

import type { ArchetypeDescriptor } from "./archetype.js";
import type { ComponentDescriptor, ComponentName } from "./component.js";

/**
 * Names of every component — required and optional — on the archetype
 * parameter. Accepts an `ArchetypeDescriptor` (storage-typed ids) or a bare
 * component tuple (query-view ids). An unresolvable parameter yields `never`
 * and an untyped descriptor yields a `string` index signature — either way the
 * resulting id satisfies only `With<[]>`, never a named constraint.
 */
type PresenceKeys<Arch> =
  Arch extends ArchetypeDescriptor<infer C, infer O>
    ? ComponentName<C[number] | O[number]>
    : Arch extends readonly ComponentDescriptor[]
      ? ComponentName<Arch[number]>
      : never;

/** Compile-time component presence map derived from the archetype parameter. */
type ComponentPresenceMap<Arch> = { [K in PresenceKeys<Arch>]: true };

/**
 * Brand type to distinguish EntityId from raw numbers at the type level.
 *
 * The archetype parameter carries a component presence map so relation write
 * sites can shape-check targets via {@link With}; it is erased at runtime and
 * defaults to `unknown` (empty presence map), so `EntityId<A>` is assignable
 * to plain `EntityId` everywhere.
 */
export type EntityId<_Arch = unknown> = number & {
  readonly __brand: "EntityId";
  readonly __ecstatic_entity_meta: {
    components: ComponentPresenceMap<_Arch>;
    archetype: _Arch;
  };
};

/**
 * Cross-archetype constraint: accepts any `EntityId` whose archetype includes
 * the given component(s) — a single component, or a readonly tuple where
 * `With<[]>` admits every `EntityId`.
 */
export type With<C extends ComponentDescriptor | readonly ComponentDescriptor[]> = EntityId & {
  readonly __ecstatic_entity_meta: {
    components: {
      [K in C extends readonly ComponentDescriptor[] ? C[number] : C as ComponentName<K>]: true;
    };
  };
};

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

/** Hot-path extraction used throughout storage indexing. */
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
