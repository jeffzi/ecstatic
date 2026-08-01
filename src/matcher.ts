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
 * Full all/any/none matcher test against an entity bitmask:
 *
 * - `allMask` — every required optional bit must be set.
 * - `anyMask` — at least one of these bits must be set, unless the matcher
 *   constrains none (`anyMask === 0` short-circuits to pass).
 * - `noneMask` — none of these bits may be set.
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
 * Returns an existing Matcher for the given masks, or creates and registers
 * a new one — deduped by the (all, any, none) triple. A matcher registered
 * on a storage with live rows backfills `matched` for all of them.
 */
export function matcherFor(
  storage: Storage,
  allMask: number,
  anyMask: number,
  noneMask: number,
): Matcher {
  const matchers = storage.matchers;
  for (let qi = 0; qi < matchers.length; qi++) {
    const qs = matchers[qi]!;
    if (qs.allMask === allMask && qs.anyMask === anyMask && qs.noneMask === noneMask) {
      return qs;
    }
  }

  // Capacity-sized so matched stays parallel to the dense arrays; backfill
  // the live rows against their current masks.
  const matched = new Uint8Array(storage.entities.length);
  const n = storage.n;
  const maskArr = storage.mask;
  for (let i = 0; i < n; i++) {
    matched[i] = maskSatisfies(maskArr[i]!, allMask, anyMask, noneMask) ? 1 : 0;
  }

  const filterMask = allMask | anyMask | noneMask;
  const qs: Matcher = { allMask, anyMask, noneMask, filterMask, matched };
  matchers.push(qs);
  storage.matcherMatched.push(matched);
  return qs;
}

/**
 * Refresh layer — recompute the derived `matched` cache for one row after a
 * single mask change. `changedBit` carries the bits that were set or
 * cleared; matchers whose `filterMask` doesn't overlap are skipped, and that
 * skip leaves their visit sets intact.
 */
export function refreshMatchersBit(
  storage: Storage,
  di: number,
  newMask: number,
  changedBit: number,
  count: number,
): void {
  const matched = storage.matcherMatched;
  const matchers = storage.matchers;
  for (let mi = 0; mi < count; mi++) {
    const m = matchers[mi]!;
    if ((changedBit & m.filterMask) !== 0) {
      matched[mi]![di] = maskSatisfies(newMask, m.allMask, m.anyMask, m.noneMask) ? 1 : 0;
    }
  }
}

/**
 * Refresh layer — recompute the derived `matched` cache for one row against
 * a full spawn mask, across all of the storage's matchers. Runs
 * unconditionally on every spawn: recycled rows hold the previous
 * occupant's flags.
 */
export function refreshMatchersMask(storage: Storage, di: number, mask: number): void {
  const matcherN = storage.matchers.length;
  if (matcherN !== 0) {
    const matched = storage.matcherMatched;
    const matchers = storage.matchers;
    for (let mi = 0; mi < matcherN; mi++) {
      const m = matchers[mi]!;
      matched[mi]![di] = maskSatisfies(mask, m.allMask, m.anyMask, m.noneMask) ? 1 : 0;
    }
  }
}

/**
 * Write layer — set optional-component bits for one row (the `enable`
 * primitive). ORs `mask` into the authoritative row mask, then refreshes the
 * derived cache; `mask` doubles as the changed-bits argument — every set bit
 * is newly enabled.
 */
export function applyMaskOr(storage: Storage, di: number, mask: number): void {
  const entityMask = storage.mask;
  const newMask = entityMask[di]! | mask;
  entityMask[di] = newMask;
  const matcherN = storage.matchers.length;
  if (matcherN !== 0) {
    refreshMatchersBit(storage, di, newMask, mask, matcherN);
  }
}

/**
 * Write layer — clear optional-component bits for one row (the `disable`
 * primitive). ANDs `notMask` (the precomputed complement of the bits being
 * cleared) into the authoritative row mask, then refreshes the derived
 * cache; the positive bits being cleared are passed as `mask`.
 */
export function applyMaskAnd(storage: Storage, di: number, mask: number, notMask: number): void {
  const entityMask = storage.mask;
  const newMask = entityMask[di]! & notMask;
  entityMask[di] = newMask;
  const matcherN = storage.matchers.length;
  if (matcherN !== 0) {
    refreshMatchersBit(storage, di, newMask, mask, matcherN);
  }
}

/**
 * Refresh layer (batch) — recompute the derived cache for every live row
 * after a batch mask change, with inverted nesting: per matcher, then per
 * row. Hoisting the per-matcher masks and `matched` array out of the row
 * loop eliminates the per-row lookups of the row-major shape. Matchers whose
 * `filterMask` doesn't overlap `changedBits` are skipped, leaving their
 * visit sets intact.
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
    const matcher = matchers[mi]!;
    if ((changedBits & matcher.filterMask) !== 0) {
      refreshOneMatcherDense(entityMask, matcher, matched[mi]!, n);
    }
  }
}

/** One matcher's flags over the dense range [0, n), with the masks hoisted. */
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
    matched[i] = maskSatisfies(entityMask[i]!, allMask, anyMask, noneMask) ? 1 : 0;
  }
}

/**
 * Refresh layer (batch, ids form) — like {@link refreshMatchersAll} but over
 * pre-resolved dense rows (`rows[0..rowCount)`), reusing the caller's cached
 * indices so the refresh pass pays array reads instead of re-resolving ids.
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
  for (let mi = 0; mi < matcherN; mi++) {
    const matcher = matchers[mi]!;
    if ((changedBits & matcher.filterMask) !== 0) {
      refreshOneMatcherRows(entityMask, matcher, matched[mi]!, rows, rowCount);
    }
  }
}

/** One matcher's flags over pre-resolved dense rows, with the masks hoisted. */
function refreshOneMatcherRows(
  entityMask: Uint32Array,
  matcher: Matcher,
  matched: Uint8Array,
  rows: readonly number[],
  rowCount: number,
): void {
  const allMask = matcher.allMask;
  const anyMask = matcher.anyMask;
  const noneMask = matcher.noneMask;
  for (let k = 0; k < rowCount; k++) {
    const di = rows[k]!;
    matched[di] = maskSatisfies(entityMask[di]!, allMask, anyMask, noneMask) ? 1 : 0;
  }
}

/**
 * Rebuild every matcher's `matched` array at the new capacity, keeping
 * `storage.matcherMatched[i]` the same object as `storage.matchers[i].matched`
 * (the flatColumns pattern: both views rebuilt together on growth).
 */
export function growMatcherArrays(storage: Storage, capacity: number): void {
  const matchers = storage.matchers;
  const matcherMatched = storage.matcherMatched;
  for (let mi = 0; mi < matchers.length; mi++) {
    const m = matchers[mi]!;
    const next = new Uint8Array(capacity);
    next.set(m.matched);
    m.matched = next;
    matcherMatched[mi] = next;
  }
}
