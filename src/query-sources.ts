/**
 * Reverse queries: iterate, list, probe, or count the source entities linked
 * to a target through a relation, walking the world's reverse map instead of
 * scanning storages.
 *
 * A stale target ID (one whose generation has advanced) visits nothing,
 * matching `getTarget` — no aliasing onto a recycled slot. An unregistered
 * relation (no reverse-map entry) also visits nothing.
 *
 * On a warm world the unfiltered paths allocate no data structures of their
 * own: `hasSources`/`countSources` only probe the bucket, and unfiltered
 * `querySources` binds the same pooled per-storage views as `query`,
 * released in a `finally` so a throwing callback unwinds cleanly. The
 * filtered `querySources` overloads pay `normalizeFilter`'s one axes tuple
 * per storage resolution. The bucket walks do go through the engine's Map
 * iteration protocol, whose transient iterator objects optimized JS engines
 * elide — the allocation gate measures the heap-delta contract, not this
 * module.
 */

import type { ComponentDescriptor } from "./component.js";
import type { EntityId } from "./entity-id.js";
import { entityIndex } from "./entity-id.js";
import type { BoundView, EachView } from "./entity/each.js";
import { acquireView, releaseView } from "./entity/each.js";
import type { SourceBucket } from "./entity/reverse-map.js";
import { soleStorage, sourceBucket } from "./entity/reverse-map.js";
import type { EachFilter } from "./filter.js";
import { resolveFilter } from "./filter.js";
import type { Matcher } from "./matcher.js";
import type { QueryView } from "./query.js";
import type { Relation } from "./relation.js";
import type { Storage, World } from "./world.js";

/**
 * The live source bucket for a (relation, target) pair, or `undefined` when
 * the target is stale, the relation is unregistered, or no source was ever
 * linked to the target.
 */
function resolveBucket(
  world: World,
  rel: ComponentDescriptor,
  target: EntityId,
): SourceBucket | undefined {
  const targetIndex = entityIndex(target);
  // Stale target → no sources (no error, matches getTarget behavior)
  if (world.generation[targetIndex] !== target) {
    return undefined;
  }
  const relMap = world.reverseMap.get(rel);
  if (relMap === undefined) {
    return undefined;
  }
  return sourceBucket(relMap, targetIndex);
}

/**
 * Iterate all source entities that link to a given target via a relation.
 *
 * Visits every source seeded by birth-link (`spawn`/`spawnMany`) or `link`,
 * across all source archetypes, binding each source through the pooled
 * per-storage view (the same view shape as `query`). Iteration order is the
 * bucket's insertion order; despawning the current source inside the
 * callback is safe. A source linked to the same target mid-pass IS visited
 * in the same pass (JS Map iteration sees entries inserted during the walk
 * — unlike `each`, whose backward row scan skips mid-pass spawns).
 *
 * With a filter (`{all?, any?, none?}` or the component-array `{all}`
 * shorthand), resolution is per storage: a storage that can never match is
 * skipped without touching its sources, and per-source enabled-bit semantics
 * match `each` filters.
 */
export function querySources<R extends Relation>(
  world: World,
  rel: R,
  target: EntityId,
  fn: (view: QueryView<R>) => void,
): void;
export function querySources<
  R extends Relation,
  const Comps extends readonly [ComponentDescriptor, ...ComponentDescriptor[]],
>(
  world: World,
  rel: R,
  target: EntityId,
  filter: readonly [...Comps],
  fn: (view: QueryView<R | Comps[number]>) => void,
): void;
export function querySources<
  R extends Relation,
  const Any extends readonly ComponentDescriptor[] = readonly [],
>(
  world: World,
  rel: R,
  target: EntityId,
  filter: {
    readonly all?: readonly [];
    readonly any?: readonly [...Any];
    readonly none?: readonly ComponentDescriptor[];
    readonly __ecstatic_name?: never;
  },
  fn: (view: QueryView<R, Any[number]>) => void,
): void;
export function querySources<
  R extends Relation,
  const All extends readonly [ComponentDescriptor, ...ComponentDescriptor[]],
  const Any extends readonly ComponentDescriptor[] = readonly [],
>(
  world: World,
  rel: R,
  target: EntityId,
  filter: {
    readonly all: readonly [...All];
    readonly any?: readonly [...Any];
    readonly none?: readonly ComponentDescriptor[];
    readonly __ecstatic_name?: never;
  },
  fn: (view: QueryView<R | All[number], Any[number]>) => void,
): void;
export function querySources(
  world: World,
  rel: ComponentDescriptor,
  target: EntityId,
  filterOrFn: unknown,
  maybeFn?: unknown,
): void {
  const bucket = resolveBucket(world, rel, target);
  if (bucket === undefined) {
    return;
  }

  if (maybeFn === undefined) {
    if (typeof filterOrFn !== "function") {
      throw new Error("invalid querySources callback");
    }
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the overloads type fn as a view callback; runtime views are EachView objects
    querySourcesUnfiltered(bucket, filterOrFn as (view: EachView) => void);
    return;
  }

  if (typeof maybeFn !== "function") {
    throw new Error("invalid querySources callback");
  }
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the filtered overloads type these two arguments
  const filter = filterOrFn as readonly ComponentDescriptor[] | EachFilter;
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the overloads type fn as a view callback; runtime views are EachView objects
  const callback = maybeFn as (view: EachView) => void;
  const sole = soleStorage(world.reverseMap.get(rel)!);
  querySourcesFiltered(bucket, sole, filter, callback);
}

function querySourcesUnfiltered(bucket: SourceBucket, callback: (view: EachView) => void): void {
  // The flat bucket interleaves sources from different archetypes in
  // insertion order, so the bound view is cached behind a storage-identity
  // compare — re-acquired only when the entry's storage changes.
  let acquired: Storage | undefined;
  let bound: BoundView | undefined;
  try {
    for (const [sourceIndex, storage] of bucket) {
      if (storage !== acquired) {
        if (acquired !== undefined) {
          releaseView(acquired);
        }
        acquired = storage;
        bound = acquireView(storage);
      }
      bound!.bind(storage.sparse[sourceIndex]!);
      callback(bound!.view);
    }
  } finally {
    if (acquired !== undefined) {
      releaseView(acquired);
    }
  }
}

/** A matcher with no active masks matches every row — skip the per-row test. */
function isTrivialMatcher(matcher: Matcher): boolean {
  return matcher.allMask === 0 && matcher.anyMask === 0 && matcher.noneMask === 0;
}

/**
 * Dispatch the filtered walk: when the single-storage flag holds a storage,
 * the matcher and view resolve once and the loop reads them from locals — the
 * fast path. Otherwise sources interleave across archetypes and per-storage
 * state is cached behind a storage-identity compare.
 */
function querySourcesFiltered(
  bucket: SourceBucket,
  sole: Storage | false | undefined,
  filter: readonly ComponentDescriptor[] | EachFilter,
  callback: (view: EachView) => void,
): void {
  if (sole !== false && sole !== undefined) {
    querySourcesFilteredSole(bucket, sole, filter, callback);
  } else {
    querySourcesFilteredMulti(bucket.entries(), undefined, filter, callback);
  }
}

function querySourcesFilteredSole(
  bucket: SourceBucket,
  sole: Storage,
  filter: readonly ComponentDescriptor[] | EachFilter,
  callback: (view: EachView) => void,
): void {
  const matcher = resolveFilter(sole, filter);
  if (matcher === false) {
    return;
  }
  const skipMatchCheck = isTrivialMatcher(matcher);
  const entries = bucket.entries();
  // The single-storage flag was read before the walk, so a source from
  // another archetype can still join the bucket mid-callback (registering an
  // archetype degrades the flag, but this walk already captured it). Rows
  // belong to `sole` only while their storage compares equal; the first
  // foreign entry hands the rest of the walk to the multi-storage loop, which
  // re-resolves the matcher and view per storage.
  let foreign: [number, Storage] | undefined;
  const bound = acquireView(sole);
  try {
    for (;;) {
      const next = entries.next();
      if (next.done === true) {
        break;
      }
      const [sourceIndex, storage] = next.value;
      if (storage !== sole) {
        foreign = next.value;
        break;
      }
      // Read sparse and matched through their owners each row: growth inside
      // the callback replaces both arrays (the each() invariant).
      const di = sole.sparse[sourceIndex]!;
      if (skipMatchCheck || matcher.matched[di] !== 0) {
        bound.bind(di);
        callback(bound.view);
      }
    }
  } finally {
    releaseView(sole);
  }
  if (foreign !== undefined) {
    querySourcesFilteredMulti(entries, foreign, filter, callback);
  }
}

/**
 * Per-storage state for the multi-storage filtered walk. Three explicit
 * outcomes needed per storage: skip the storage entirely, skip the per-row
 * check, or test the matcher's matched flags.
 */
interface MultiStorageState {
  skipStorage: boolean;
  skipMatchCheck: boolean;
  /**
   * The current storage's matcher — its `matched` array is read through it
   * per row because growth inside the callback replaces the array.
   */
  matcher: Matcher | undefined;
  /** The storage whose pooled view is currently checked out, if any. */
  acquired: Storage | undefined;
  bound: BoundView | undefined;
}

/** Re-resolve the matcher and swap the checked-out view for a new storage. */
function enterStorage(
  state: MultiStorageState,
  storage: Storage,
  filter: readonly ComponentDescriptor[] | EachFilter,
): void {
  const matcher = resolveFilter(storage, filter);
  if (matcher === false) {
    state.skipStorage = true;
    return;
  }
  state.skipStorage = false;
  state.skipMatchCheck = isTrivialMatcher(matcher);
  state.matcher = matcher;
  if (state.acquired !== undefined) {
    releaseView(state.acquired);
  }
  state.acquired = storage;
  state.bound = acquireView(storage);
}

/**
 * Walk bucket entries with per-storage state, refreshed only when the entry's
 * storage changes (storage-identity compare) — the flat bucket interleaves
 * sources from different archetypes in insertion order.
 *
 * `pending` is an entry already pulled from `entries`: the sole walk pulls one
 * to detect a foreign storage and hands the remainder of the walk over here,
 * so that entry is processed before the iterator advances again.
 */
function querySourcesFilteredMulti(
  entries: MapIterator<[number, Storage]>,
  pending: [number, Storage] | undefined,
  filter: readonly ComponentDescriptor[] | EachFilter,
  callback: (view: EachView) => void,
): void {
  let pendingEntry = pending;
  let lastStorage: Storage | undefined;
  const state: MultiStorageState = {
    skipStorage: false,
    skipMatchCheck: false,
    matcher: undefined,
    acquired: undefined,
    bound: undefined,
  };
  try {
    for (;;) {
      let entry: [number, Storage];
      if (pendingEntry !== undefined) {
        entry = pendingEntry;
        pendingEntry = undefined;
      } else {
        const next = entries.next();
        if (next.done === true) {
          break;
        }
        entry = next.value;
      }
      const [sourceIndex, storage] = entry;
      if (storage !== lastStorage) {
        lastStorage = storage;
        enterStorage(state, storage, filter);
      }
      if (state.skipStorage) {
        continue;
      }
      const di = storage.sparse[sourceIndex]!;
      if (state.skipMatchCheck || state.matcher!.matched[di] !== 0) {
        state.bound!.bind(di);
        callback(state.bound!.view);
      }
    }
  } finally {
    if (state.acquired !== undefined) {
      releaseView(state.acquired);
    }
  }
}

/**
 * Return all source entity IDs linked to a given target via a relation — the
 * non-callback complement to `querySources` (same visit set, no filtering).
 *
 * Pass `out` to reuse an existing array: it is filled and returned with the
 * tail cleared, so `result.length === n` holds on every call. A stale target
 * or unregistered relation yields an empty result (out-form: `out` emptied).
 */
export function getSources(
  world: World,
  rel: Relation,
  target: EntityId,
  out?: EntityId[],
): EntityId[] {
  const result: number[] = out ?? [];
  let count = 0;

  const bucket = resolveBucket(world, rel, target);
  if (bucket !== undefined) {
    for (const [sourceIndex, storage] of bucket) {
      const di = storage.sparse[sourceIndex]!;
      result[count] = storage.entities[di]!;
      count++;
    }
  }

  // Truncate the reused tail (no-op for a fresh array)
  result.length = count;
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- branded type boundary: the entities column stores packed entity IDs
  return result as EntityId[];
}

/**
 * Whether at least one source is linked to the target via the relation.
 * Stale targets and unregistered relations report `false`. Zero allocation.
 */
export function hasSources(world: World, rel: Relation, target: EntityId): boolean {
  const bucket = resolveBucket(world, rel, target);
  return bucket !== undefined && bucket.size !== 0;
}

/**
 * Number of source entities linked to the target via the relation, across
 * all archetypes. Stale targets and unregistered relations report `0`.
 * Zero allocation.
 */
export function countSources(world: World, rel: Relation, target: EntityId): number {
  const bucket = resolveBucket(world, rel, target);
  return bucket === undefined ? 0 : bucket.size;
}
