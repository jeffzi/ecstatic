/**
 * Reverse queries: iterate, list, probe, or count the source entities linked
 * to a target through a relation, walking the world's reverse map instead of
 * scanning storages.
 *
 * A stale target ID (one whose generation has advanced) visits nothing,
 * matching `getTarget`: the check compares generations, so a dead ID matches
 * again only once its slot has been despawned 1,023 times since the ID was
 * issued, the ID's own despawn included, and then taken by a new entity. An
 * unregistered relation (no reverse-map entry) also visits nothing.
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

function releaseIfAcquired(storage: Storage | undefined): void {
  if (storage !== undefined) releaseView(storage);
}

/**
 * Resolve the live source bucket for a (relation, target) pair.
 *
 * @param world - World whose `generation` table validates the target and whose `reverseMap`
 *   holds the relation's buckets.
 * @param rel - Relation descriptor keying the reverse map.
 * @param target - Packed entity id of the link target; its generation is checked, not just its
 *   index, so a dead id matches again only once its slot has been despawned 1,023 times since
 *   the id was issued, the id's own despawn included, and then taken by a new entity.
 * @returns The bucket mapping source index to source storage — the world's own live `Map`, not a
 *   copy — or `undefined` when the target is stale, the relation is unregistered, or no source
 *   was ever linked to the target (buckets persist once created, so one may be empty).
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
 *
 * @param world - World whose reverse map is walked.
 * @param rel - Relation the sources link through.
 * @param target - Packed entity id of the link target; a stale id (generation advanced) visits
 *   nothing rather than throwing.
 * @param filter - Optional. Component-array `{all}` shorthand or `{all?, any?, none?}` descriptor,
 *   resolved per storage; when given, `fn` is the following argument and sees only matching
 *   sources.
 * @param fn - Called once per source with the pooled per-storage view, rebound to each row; the
 *   view object is reused across calls, so it is valid only for the duration of the callback.
 * @throws If the callback argument is not a function (reachable only from untyped callers).
 */
/* oxlint-disable max-params -- public API: querySources overloads */
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
  /* oxlint-enable max-params */
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
  const relMap = world.reverseMap.get(rel);
  /* istanbul ignore next */
  if (relMap === undefined) throw new Error("invariant: relation not in reverse map");
  const sole = soleStorage(relMap);
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
        releaseIfAcquired(acquired);
        acquired = storage;
        bound = acquireView(storage);
      }
      /* istanbul ignore next */
      if (bound === undefined) throw new Error("invariant: bound view unset after acquire");
      const di = storage.sparse[sourceIndex];
      /* istanbul ignore next */
      if (di === undefined) throw new Error("invariant: source missing from sparse array");
      bound.bind(di);
      callback(bound.view);
    }
  } finally {
    releaseIfAcquired(acquired);
  }
}

/**
 * A matcher with no active masks matches every row, so the per-row flag test can be skipped.
 *
 * @param matcher - Matcher resolved for the current storage (never `false`; callers check that
 *   first).
 * @returns `true` when all three masks are 0 — the shape `resolveFilter` returns as
 *   `TRIVIAL_MATCHER` when required components alone satisfy every constraint.
 */
function isTrivialMatcher(matcher: Matcher): boolean {
  return matcher.allMask === 0 && matcher.anyMask === 0 && matcher.noneMask === 0;
}

/**
 * Dispatch the filtered walk: when the single-storage flag holds a storage, the matcher and view
 * resolve once and the loop reads them from locals — the fast path. Otherwise sources interleave
 * across archetypes and per-storage state is cached behind a storage-identity compare.
 *
 * @param bucket - Live source bucket for the target, walked in insertion order.
 * @param sole - The relation's single-storage flag as read before the walk: a `Storage` while
 *   one storage has ever sourced the relation, `false` once sources span several, `undefined`
 *   before the first insert.
 * @param filter - Component-array `{all}` shorthand or `{all?, any?, none?}` descriptor,
 *   resolved per storage.
 * @param callback - Invoked with the pooled view bound to each matching source row.
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
      const di = sole.sparse[sourceIndex];
      /* istanbul ignore next */
      if (di === undefined) throw new Error("invariant: source missing from sparse array");
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

interface ReadyState {
  matcher: Matcher;
  bound: BoundView;
}

function assertStorageReady(
  state: MultiStorageState,
): asserts state is MultiStorageState & ReadyState {
  /* istanbul ignore next */
  if (state.matcher === undefined || state.bound === undefined) {
    throw new Error("invariant: enterStorage must set matcher and bound before row access");
  }
}

/**
 * Re-resolve the matcher and swap the checked-out view for a new storage.
 *
 * @param state - Walk state mutated in place: `skipStorage` is set when the storage can never
 *   match (and nothing else changes), otherwise `skipMatchCheck`, `matcher`, `acquired`, and
 *   `bound` are refreshed and the previously acquired view is released.
 * @param storage - The storage the next bucket entries belong to.
 * @param filter - Component-array shorthand or `{all?, any?, none?}` descriptor resolved against
 *   `storage`.
 */
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

function pullNext<T>(iter: IterableIterator<T>): T | undefined {
  const next = iter.next();
  return next.done === true ? undefined : next.value;
}

/**
 * Walk bucket entries with per-storage state, refreshed only when the entry's storage changes
 * (storage-identity compare) — the flat bucket interleaves sources from different archetypes in
 * insertion order.
 *
 * @param entries - Bucket iterator, possibly already advanced by the sole-storage walk; consumed
 *   to exhaustion.
 * @param pending - An entry already pulled from `entries`: the sole walk pulls one to detect a
 *   foreign storage and hands the remainder of the walk over here, so that entry is processed
 *   before the iterator advances again. `undefined` when the walk starts from the iterator.
 * @param filter - Component-array shorthand or `{all?, any?, none?}` descriptor, re-resolved on
 *   each storage change.
 * @param callback - Invoked with the pooled view bound to each matching source row; the view of
 *   the last storage entered is released in a `finally`, even when the callback throws.
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
      const entry = pendingEntry ?? pullNext(entries);
      pendingEntry = undefined;
      if (entry === undefined) break;
      const [sourceIndex, storage] = entry;
      if (storage !== lastStorage) {
        lastStorage = storage;
        enterStorage(state, storage, filter);
      }
      if (state.skipStorage) {
        continue;
      }
      const di = storage.sparse[sourceIndex];
      /* istanbul ignore next */
      if (di === undefined) throw new Error("invariant: source missing from sparse array");
      assertStorageReady(state);
      if (state.skipMatchCheck || state.matcher.matched[di] !== 0) {
        state.bound.bind(di);
        callback(state.bound.view);
      }
    }
  } finally {
    releaseIfAcquired(state.acquired);
  }
}

/**
 * Return all source entity IDs linked to a given target via a relation — the non-callback
 * complement to `querySources` (same visit set, no filtering).
 *
 * @param world - World whose reverse map is read.
 * @param rel - Relation the sources link through.
 * @param target - Packed entity id of the link target.
 * @param out - Optional buffer to reuse: ids are written from index 0 and its length is set to
 *   the source count, truncating any longer tail; a stale target or unregistered relation
 *   empties it. Omit to allocate a fresh array.
 * @returns The ids in bucket insertion order — `out` itself when given, else a new array — so
 *   `result.length` is the source count on every call.
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
      const di = storage.sparse[sourceIndex];
      /* istanbul ignore next */
      if (di === undefined) throw new Error("invariant: source missing from sparse array");
      const entityId = storage.entities[di];
      /* istanbul ignore next */
      if (entityId === undefined) throw new Error("invariant: entity missing from dense array");
      result[count] = entityId;
      count++;
    }
  }

  // Truncate the reused tail (no-op for a fresh array)
  result.length = count;
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- branded type boundary: the entities column stores packed entity IDs
  return result as EntityId[];
}

/**
 * Whether at least one source is linked to the target via the relation. Zero allocation: only
 * the bucket's size is probed.
 *
 * @param world - World whose reverse map is read.
 * @param rel - Relation the sources link through.
 * @param target - Packed entity id of the link target.
 * @returns `true` when the target's bucket holds a source; `false` for a stale target, an
 *   unregistered relation, or a bucket whose sources were all unlinked.
 */
export function hasSources(world: World, rel: Relation, target: EntityId): boolean {
  const bucket = resolveBucket(world, rel, target);
  return bucket !== undefined && bucket.size !== 0;
}

/**
 * Number of source entities linked to the target via the relation, across all archetypes. Zero
 * allocation: only the bucket's size is read.
 *
 * @param world - World whose reverse map is read.
 * @param rel - Relation the sources link through.
 * @param target - Packed entity id of the link target.
 * @returns The bucket size, or `0` for a stale target or an unregistered relation.
 */
export function countSources(world: World, rel: Relation, target: EntityId): number {
  const bucket = resolveBucket(world, rel, target);
  return bucket === undefined ? 0 : bucket.size;
}
