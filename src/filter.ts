/**
 * Filter resolution: map an all/any/none component filter onto a storage's
 * optional bitmasks, producing a Matcher (or a skip/trivial outcome) per
 * storage. `resolveFilterMasks` allocates nothing per call — the three id
 * arrays are read directly, with no normalized filter object.
 * `normalizeFilter` does allocate one axes tuple per call, so callers on hot
 * paths pay one small allocation per resolution.
 */

import type { ComponentDescriptor } from "./component.js";
import type { Matcher } from "./matcher.js";
import { matcherFor } from "./matcher.js";
import type { Storage, WorldState } from "./world.js";

/**
 * Component filter for `each`: entities must have every `all` component,
 * at least one `any` component, and no `none` component. All axes optional;
 * a bare component array is shorthand for `{all}`.
 */
export interface EachFilter {
  readonly all?: readonly ComponentDescriptor[];
  readonly any?: readonly ComponentDescriptor[];
  readonly none?: readonly ComponentDescriptor[];
  /** Guard against passing a bare component descriptor as a filter. */
  readonly __ecstatic_name?: never;
}

/**
 * Component filter for `query`: like {@link EachFilter}, but the `all` axis
 * is required and non-empty — query fans out over the archetypes that carry
 * the `all` components, so an unconstrained query is a compile error.
 */
export interface QueryFilter {
  readonly all: readonly [ComponentDescriptor, ...ComponentDescriptor[]];
  readonly any?: readonly ComponentDescriptor[];
  readonly none?: readonly ComponentDescriptor[];
  /** Guard against passing a bare component descriptor as a filter. */
  readonly __ecstatic_name?: never;
}

/**
 * Shared empty-axis sentinel: `normalizeFilter` returns it for absent axes so
 * resolution allocates nothing per call.
 */
export const EMPTY_COMPONENT_IDS: readonly ComponentDescriptor[] = [];

/**
 * Sentinel returned by `resolveFilterMasks` when all computed masks are zero.
 *
 * When every component in the `all` list is a required column (not optional)
 * and there are no `any` or `none` constraints left, the bitmask check
 * reduces to trivially-true — iteration visits every row unconditionally.
 * This sentinel lets dispatch take that path without ever allocating a
 * `matched[]` array or registering a matcher on `storage.matchers`:
 *
 * - `storage.matchers.length` stays 0 for storages with only trivial filters.
 * - The spawn/despawn refresh loops are skipped entirely.
 * - The refresh layer never sees this sentinel — it is never registered.
 *
 * Safe because dispatch checks the three masks for zero before reading
 * `matched`, so the empty array is never accessed.
 */
export const TRIVIAL_MATCHER: Matcher = {
  allMask: 0,
  anyMask: 0,
  noneMask: 0,
  filterMask: 0,
  matched: new Uint8Array(0),
};

/** True when the storage's archetype carries every listed component (required or optional). */
function storageHasAll(storage: Storage, compIds: readonly ComponentDescriptor[]): boolean {
  for (const comp of compIds) {
    if (!storage.componentLookup.has(comp)) {
      return false;
    }
  }
  return true;
}

/** Storages in the world whose archetypes carry all listed components. */
export function findArchetypes(
  world: WorldState,
  compIds: readonly ComponentDescriptor[],
): Storage[] {
  const archetypes: Storage[] = [];
  for (const storage of world.storages.values()) {
    if (storageHasAll(storage, compIds)) {
      archetypes.push(storage);
    }
  }
  return archetypes;
}

/**
 * Decompose a filter (descriptor object or bare `{all}` component array)
 * into its three axes, defaulting absent axes to the shared empty sentinel.
 * Shared by `resolveFilter` and `query`, which both accept the same
 * array-or-object filter grammar.
 */
export function normalizeFilter(
  filter: EachFilter | readonly ComponentDescriptor[],
): readonly [
  allIds: readonly ComponentDescriptor[],
  anyIds: readonly ComponentDescriptor[],
  noneIds: readonly ComponentDescriptor[],
] {
  if (Array.isArray(filter)) {
    return [filter, EMPTY_COMPONENT_IDS, EMPTY_COMPONENT_IDS];
  }
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Array.isArray does not narrow readonly arrays
  const f = filter as EachFilter;
  return [
    f.all ?? EMPTY_COMPONENT_IDS,
    f.any ?? EMPTY_COMPONENT_IDS,
    f.none ?? EMPTY_COMPONENT_IDS,
  ];
}

/**
 * Resolve a filter (descriptor object or bare `{all}` component array)
 * against a storage. Returns the Matcher on match, `false` if the storage
 * can never satisfy the filter, or {@link TRIVIAL_MATCHER} when every
 * constraint is trivially satisfied.
 */
export function resolveFilter(
  storage: Storage,
  filter: EachFilter | readonly ComponentDescriptor[],
): Matcher | false {
  const [allIds, anyIds, noneIds] = normalizeFilter(filter);
  return resolveFilterMasks(storage, allIds, anyIds, noneIds);
}

/**
 * Resolve the `any` axis: returns the bitmask for optional-component membership,
 * or `false` when the axis is impossible (all components absent from the archetype).
 * When a required component satisfies the axis, the returned mask is 0 (trivially
 * satisfied — no per-row bitmask check needed).
 */
function resolveAnyMask(
  anyIds: readonly ComponentDescriptor[],
  optionalBitLookup: ReadonlyMap<ComponentDescriptor, number>,
  componentLookup: ReadonlySet<ComponentDescriptor>,
): number | false {
  let mask = 0;
  let hasPresentComponent = false;
  for (const cid of anyIds) {
    const bit = optionalBitLookup.get(cid);
    if (bit !== undefined) {
      mask |= bit;
    } else if (componentLookup.has(cid)) {
      hasPresentComponent = true;
    }
  }
  if (anyIds.length > 0 && mask === 0 && !hasPresentComponent) {
    return false;
  }
  if (hasPresentComponent) {
    return 0;
  }
  return mask;
}

/**
 * Resolve the three filter axes against a storage's component sets:
 *
 * - `all`: a required component is trivially satisfied; an optional
 *   contributes its bit; a component absent from the archetype makes the
 *   whole storage unmatchable.
 * - `any`: optionals contribute bits; a required component makes the any-leg
 *   trivially pass (mask cleared); all-absent components with no bits makes
 *   the storage unmatchable.
 * - `none`: optionals contribute bits; a required component makes the
 *   storage unmatchable; absent components are trivially satisfied.
 */
// fallow-ignore-next-line complexity
export function resolveFilterMasks(
  storage: Storage,
  allIds: readonly ComponentDescriptor[],
  anyIds: readonly ComponentDescriptor[],
  noneIds: readonly ComponentDescriptor[],
): Matcher | false {
  const componentLookup = storage.componentLookup;
  const optionalBitLookup = storage.optionalBitLookup;

  let allMask = 0;
  for (const cid of allIds) {
    const bit = optionalBitLookup.get(cid);
    if (bit !== undefined) {
      allMask |= bit;
    } else if (!componentLookup.has(cid)) {
      return false;
    }
  }

  const anyMask = resolveAnyMask(anyIds, optionalBitLookup, componentLookup);
  if (anyMask === false) {
    return false;
  }

  let noneMask = 0;
  for (const cid of noneIds) {
    const bit = optionalBitLookup.get(cid);
    if (bit !== undefined) {
      noneMask |= bit;
    } else if (componentLookup.has(cid)) {
      return false;
    }
  }

  if (allMask === 0 && anyMask === 0 && noneMask === 0) {
    return TRIVIAL_MATCHER;
  }

  return matcherFor(storage, allMask, anyMask, noneMask);
}
