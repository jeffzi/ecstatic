/**
 * Seeded pseudo-random numbers for the benchmark suite.
 *
 * Benchmarks must be reproducible: the same seed has to produce the same
 * entity layout, the same shuffle order, and therefore the same memory access
 * pattern on every run. `Math.random` cannot give that, so the suite uses
 * mulberry32 — a small, fast 32-bit generator with a 2^32 period.
 */

/** Divisor turning a uint32 into a float in `[0, 1)`. */
const UINT32_RANGE = 2 ** 32;

/**
 * Create a mulberry32 generator seeded with `seed`.
 *
 * The returned function yields a float in `[0, 1)` and advances the generator
 * state on every call. Two generators built from the same seed emit the same
 * sequence.
 *
 * The seed domain is uint32: it is truncated toward zero and wrapped modulo
 * 2^32, so seeds differing only above that width — or only in their fractional
 * part — share a stream.
 */
export function mulberry32(seed: number): () => number {
  let state = seed | 0;
  return (): number => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / UINT32_RANGE;
  };
}

/**
 * Fisher-Yates in-place shuffle driven by `rand`, returning `arr` itself.
 *
 * Pass a `mulberry32` generator to get a reproducible permutation.
 */
export function shuffle<T>(arr: T[], rand: () => number): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const tmp = arr[i]!;
    arr[i] = arr[j]!;
    arr[j] = tmp;
  }
  return arr;
}
