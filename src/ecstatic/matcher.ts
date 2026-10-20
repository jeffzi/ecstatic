/**
 * Matcher state: per-storage all/any/none bitmask matchers and the derived
 * per-row `matched[]` cache filtered iteration reads.
 *
 * Two layers cooperate here. The **write layer** (`applyMaskOr` /
 * `applyMaskAnd`) mutates the authoritative per-row mask; the **refresh
 * layer** (`refreshMatchersBit` / `refreshMatchersMask`) reconciles the
 * derived `matched[mi][di]` cache, which records whether row `di` satisfies
 * matcher `mi`'s constraints. Every mask mutation refreshes synchronously,
 * so filtered iteration reads one byte per row with no revalidation.
 *
 * This module is the single owner of every `matched[]` mutation; despawn's
 * swap sites copy whole rows of flags but never recompute them.
 */

import type { Storage } from "./world.js";

/**
 * Per-storage bitmask match state, registered by `matcherFor` on first use
 * and updated by the refresh layer on mask changes. `matched` is
 * capacity-sized, parallel to the storage's dense arrays; rows ≥ `n` are
 * never read (bulk despawn leaves them stale by design).
 */
export interface Matcher {
  allMask: number;
  anyMask: number;
  noneMask: number;
  /** Union of the three masks: refreshes skip matchers whose filter mask doesn't overlap the changed bits. */
  filterMask: number;
  matched: Uint8Array;
}

/**
 * Full all/any/none matcher test against an entity bitmask.
 *
 * @param mask - The row's optional-component presence bits, one bit per enabled optional.
 * @param allMask - Bits that must all be set in `mask`; 0 imposes no constraint.
 * @param anyMask - Bits of which at least one must be set in `mask`; 0 short-circuits to pass,
 *   so a matcher that constrains no `any` axis never fails this leg.
 * @param noneMask - Bits that must all be clear in `mask`; 0 imposes no constraint.
 * @returns `true` when `mask` satisfies all three legs.
 */
export function maskSatisfies(
  mask: number,
  allMask: number,
  anyMask: number,
  noneMask: number,
): boolean {
  return (
    (mask & allMask) === allMask &&
    (anyMask === 0 || (mask & anyMask) !== 0) &&
    (mask & noneMask) === 0
  );
}

/**
 * Find or register the storage's matcher for an (all, any, none) mask triple — deduped, so
 * repeated filter resolution against the same storage shares one `matched` cache.
 *
 * Part of the runtime contract with the optimizer: matchers are only ever added to
 * `storage.matchers`, never removed or replaced, so a matcher cached per call site stays the
 * storage's matcher for its triple. Growth replaces `matched` on that same object
 * ({@link growMatcherArrays}).
 *
 * @param storage - Storage whose `matchers` and `matcherMatched` lists are searched and, on a
 *   miss, appended to in lockstep.
 * @param allMask - Optional bits every matching row must have set.
 * @param anyMask - Optional bits of which a matching row needs at least one; 0 means no `any`
 *   constraint.
 * @param noneMask - Optional bits every matching row must have clear.
 * @returns The already-registered matcher when the exact triple exists, otherwise a new one
 *   whose `matched` array is sized to the storage capacity and backfilled for every live row
 *   against its current mask. Shared by every caller of the same triple; never mutate its masks.
 */
export function matcherFor(
  storage: Storage,
  allMask: number,
  anyMask: number,
  noneMask: number,
): Matcher {
  const matchers = storage.matchers;
  for (let mi = 0; mi < matchers.length; mi++) {
    // oxlint-disable-next-line typescript/no-non-null-assertion -- mi < matchers.length
    const m = matchers[mi]!;
    if (m.allMask === allMask && m.anyMask === anyMask && m.noneMask === noneMask) {
      return m;
    }
  }

  // Capacity-sized (not n-sized) so matched stays parallel to the dense
  // arrays.
  const matched = new Uint8Array(storage.entities.length);
  const n = storage.n;
  const maskArr = storage.mask;
  for (let i = 0; i < n; i++) {
    // oxlint-disable-next-line typescript/no-non-null-assertion -- i < n ≤ maskArr.length
    matched[i] = maskSatisfies(maskArr[i]!, allMask, anyMask, noneMask) ? 1 : 0;
  }

  const filterMask = allMask | anyMask | noneMask;
  const m: Matcher = { allMask, anyMask, noneMask, filterMask, matched };
  matchers.push(m);
  storage.matcherMatched.push(matched);
  return m;
}

/**
 * Refresh layer — recompute the derived `matched` cache for one row after a single mask change.
 * Matchers whose `filterMask` doesn't overlap `changedBit` are skipped, and that skip leaves
 * their visit sets intact.
 *
 * @param storage - Storage whose `matchers` and parallel `matcherMatched` arrays are updated.
 * @param di - Dense row index whose flags are recomputed; must be a live row (`di < storage.n`).
 * @param newMask - The row's complete mask after the change, tested as-is — `storage.mask[di]` is
 *   not read, so callers may write it before or after this call.
 * @param changedBit - The bits that were set or cleared by the change; a matcher is visited only
 *   when this overlaps its `filterMask`.
 */
export function refreshMatchersBit(
  storage: Storage,
  di: number,
  newMask: number,
  changedBit: number,
): void {
  const matched = storage.matcherMatched;
  const matchers = storage.matchers;
  const count = matchers.length;
  for (let mi = 0; mi < count; mi++) {
    // oxlint-disable-next-line typescript/no-non-null-assertion -- mi < count ≤ matchers.length
    const m = matchers[mi]!;
    if ((changedBit & m.filterMask) !== 0) {
      // oxlint-disable-next-line typescript/no-non-null-assertion -- mi < count; matched parallel to matchers
      matched[mi]![di] = maskSatisfies(newMask, m.allMask, m.anyMask, m.noneMask) ? 1 : 0;
    }
  }
}

/**
 * Refresh layer — recompute the derived `matched` cache for one row against a full spawn mask,
 * across all of the storage's matchers. Runs unconditionally on every spawn: recycled rows hold
 * the previous occupant's flags.
 *
 * @param storage - Storage whose matchers are all visited; a storage with none returns at once.
 * @param di - Dense row index of the freshly spawned entity.
 * @param mask - The row's complete optional-presence mask as written at spawn.
 */
export function refreshMatchersMask(storage: Storage, di: number, mask: number): void {
  const matcherN = storage.matchers.length;
  if (matcherN !== 0) {
    const matched = storage.matcherMatched;
    const matchers = storage.matchers;
    for (let mi = 0; mi < matcherN; mi++) {
      // oxlint-disable-next-line typescript/no-non-null-assertion -- mi < matcherN ≤ matchers.length
      const m = matchers[mi]!;
      // oxlint-disable-next-line typescript/no-non-null-assertion -- mi < matcherN; matched parallel to matchers
      matched[mi]![di] = maskSatisfies(mask, m.allMask, m.anyMask, m.noneMask) ? 1 : 0;
    }
  }
}

/**
 * Write layer — set optional-component bits for one row (the `enable` primitive), then refresh
 * the derived cache so filtered iteration sees the change synchronously.
 *
 * @param storage - Storage whose `mask[di]` is updated and whose matchers are refreshed.
 * @param di - Dense row index of a live entity.
 * @param mask - Bits to OR into the row mask; the same value gates the refresh as the changed
 *   bits, so pass the bits being enabled rather than a full mask (extra bits only cost extra
 *   matcher visits).
 */
export function applyMaskOr(storage: Storage, di: number, mask: number): void {
  const entityMask = storage.mask;
  // oxlint-disable-next-line typescript/no-non-null-assertion -- di is a valid dense index
  const newMask = entityMask[di]! | mask;
  entityMask[di] = newMask;
  if (storage.matchers.length !== 0) {
    refreshMatchersBit(storage, di, newMask, mask);
  }
}

/**
 * Write layer — clear optional-component bits for one row (the `disable` primitive), then
 * refresh the derived cache so filtered iteration sees the change synchronously.
 *
 * @param storage - Storage whose `mask[di]` is updated and whose matchers are refreshed.
 * @param di - Dense row index of a live entity.
 * @param mask - The positive bits being cleared; only gates the refresh as the changed bits and
 *   is never applied to the row mask itself.
 * @param notMask - Precomputed complement of `mask`, ANDed into the row mask. Must agree with
 *   `mask`: the write uses only this value and the refresh only `mask`.
 */
export function applyMaskAnd(storage: Storage, di: number, mask: number, notMask: number): void {
  const entityMask = storage.mask;
  // oxlint-disable-next-line typescript/no-non-null-assertion -- di is a valid dense index
  const newMask = entityMask[di]! & notMask;
  entityMask[di] = newMask;
  if (storage.matchers.length !== 0) {
    refreshMatchersBit(storage, di, newMask, mask);
  }
}

/**
 * Refresh layer (batch) — recompute the derived cache for every live row after a batch mask
 * change, with inverted nesting: per matcher, then per row. Hoisting the per-matcher masks and
 * `matched` array out of the row loop eliminates the per-row lookups of the row-major shape.
 * Matchers whose `filterMask` doesn't overlap `changedBits` are skipped, leaving their visit
 * sets intact.
 *
 * @param storage - Storage whose rows `[0, n)` are re-tested against each matcher; returns at
 *   once when it has no matchers.
 * @param changedBits - Union of every bit the batch set or cleared across all rows; a matcher is
 *   visited only when this overlaps its `filterMask`.
 */
export function refreshMatchersAll(storage: Storage, changedBits: number): void {
  const matcherN = storage.matchers.length;
  if (matcherN === 0) {
    return;
  }
  const entityMask = storage.mask;
  const n = storage.n;
  const matchers = storage.matchers;
  const matched = storage.matcherMatched;
  for (let mi = 0; mi < matcherN; mi++) {
    // oxlint-disable-next-line typescript/no-non-null-assertion -- mi < matcherN ≤ matchers.length
    const matcher = matchers[mi]!;
    if ((changedBits & matcher.filterMask) !== 0) {
      // oxlint-disable-next-line typescript/no-non-null-assertion -- mi < matcherN; matched parallel to matchers
      refreshOneMatcherDense(entityMask, matcher, matched[mi]!, n);
    }
  }
}

/**
 * One matcher's flags over the dense range `[0, n)`, with the masks hoisted out of the loop.
 *
 * @param entityMask - The storage's per-row mask column (`storage.mask`), read per row.
 * @param matcher - Matcher whose three masks are tested; flags are written through the `matched`
 *   argument, which aliases `matcher.matched`.
 * @param matched - Flag array written for rows `[0, n)`; the caller passes
 *   `storage.matcherMatched[mi]`, the same object as `matcher.matched`.
 * @param n - Number of live rows (`storage.n`); rows at or beyond it are left stale by design.
 */
function refreshOneMatcherDense(
  entityMask: Uint32Array,
  matcher: Matcher,
  matched: Uint8Array,
  n: number,
): void {
  const allMask = matcher.allMask;
  const anyMask = matcher.anyMask;
  const noneMask = matcher.noneMask;
  for (let i = 0; i < n; i++) {
    // oxlint-disable-next-line typescript/no-non-null-assertion -- i < n ≤ entityMask.length
    matched[i] = maskSatisfies(entityMask[i]!, allMask, anyMask, noneMask) ? 1 : 0;
  }
}

/**
 * Refresh layer (batch, ids form) — like {@link refreshMatchersAll} but over pre-resolved dense
 * rows, reusing the caller's cached indices so the refresh pass pays array reads instead of
 * re-resolving ids.
 *
 * @param storage - Storage whose matchers and `mask` column are read; returns at once when it
 *   has no matchers.
 * @param rows - Dense row indices to re-test; only `rows[0..rowCount)` are read, so a longer
 *   scratch buffer is fine.
 * @param rowCount - Number of leading entries of `rows` that are valid.
 * @param changedBits - Union of every bit the batch set or cleared; a matcher is visited only
 *   when this overlaps its `filterMask`.
 */
export function refreshMatchersRows(
  storage: Storage,
  rows: readonly number[],
  rowCount: number,
  changedBits: number,
): void {
  const matcherN = storage.matchers.length;
  if (matcherN === 0) {
    return;
  }
  const entityMask = storage.mask;
  const matchers = storage.matchers;
  const matched = storage.matcherMatched;
  const rowCtx: RowRefreshCtx = { entityMask, rows, rowCount };
  for (let mi = 0; mi < matcherN; mi++) {
    // oxlint-disable-next-line typescript/no-non-null-assertion -- mi < matcherN ≤ matchers.length
    const matcher = matchers[mi]!;
    if ((changedBits & matcher.filterMask) !== 0) {
      // oxlint-disable-next-line typescript/no-non-null-assertion -- mi < matcherN; matched parallel to matchers
      refreshOneMatcherRows(rowCtx, matcher, matched[mi]!);
    }
  }
}

interface RowRefreshCtx {
  entityMask: Uint32Array;
  rows: readonly number[];
  rowCount: number;
}

/**
 * One matcher's flags over pre-resolved dense rows, with the masks hoisted out of the loop.
 *
 * @param ctx - The mask column and row list shared by every matcher in the batch, built once per
 *   {@link refreshMatchersRows} call.
 * @param matcher - Matcher whose three masks are tested.
 * @param matched - Flag array written at each listed row; the caller passes
 *   `storage.matcherMatched[mi]`, the same object as `matcher.matched`.
 */
function refreshOneMatcherRows(ctx: RowRefreshCtx, matcher: Matcher, matched: Uint8Array): void {
  const { entityMask, rows, rowCount } = ctx;
  const allMask = matcher.allMask;
  const anyMask = matcher.anyMask;
  const noneMask = matcher.noneMask;
  for (let k = 0; k < rowCount; k++) {
    // oxlint-disable-next-line typescript/no-non-null-assertion -- k < rowCount ≤ rows.length
    const di = rows[k]!;
    // oxlint-disable-next-line typescript/no-non-null-assertion -- di is a valid dense index
    matched[di] = maskSatisfies(entityMask[di]!, allMask, anyMask, noneMask) ? 1 : 0;
  }
}

/**
 * Rebuild every matcher's `matched` array at the new capacity, keeping
 * `storage.matcherMatched[i]` the same object as `storage.matchers[i].matched` (the flatColumns
 * pattern: both views rebuilt together on growth).
 *
 * Part of the runtime contract with the optimizer: the new array is assigned to
 * `matched` on the existing matcher object; the matcher itself is never replaced, so a cached
 * matcher reads its current `matched` after growth.
 *
 * @param storage - Storage being grown; each of its matchers gets a fresh `Uint8Array` with the
 *   old flags copied in, and `matcherMatched` is rewritten in place to alias them.
 * @param capacity - New row capacity (the grown `entities.length`); never smaller than the
 *   current `matched` length.
 * @throws RangeError if `capacity` is smaller than a matcher's current `matched` length
 */
export function growMatcherArrays(storage: Storage, capacity: number): void {
  const matchers = storage.matchers;
  const matcherMatched = storage.matcherMatched;
  for (let mi = 0; mi < matchers.length; mi++) {
    // oxlint-disable-next-line typescript/no-non-null-assertion -- mi < matchers.length
    const m = matchers[mi]!;
    const next = new Uint8Array(capacity);
    next.set(m.matched);
    m.matched = next;
    matcherMatched[mi] = next;
  }
}
