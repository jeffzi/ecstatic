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
 * Create a mulberry32 generator.
 *
 * @param seed - Any number; the domain is uint32, so it is truncated toward zero and wrapped
 * modulo 2^32, and seeds differing only above that width — or only in their fractional part —
 * share a stream.
 * @returns A function yielding a float in `[0, 1)` and advancing its private state on every
 * call; two generators built from the same seed emit the same sequence.
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
 * Fisher-Yates in-place shuffle.
 *
 * @param arr - Array permuted in place; every element stays, only positions change.
 * @param rand - Source of floats in `[0, 1)`, called once per element after the first; pass a
 * `mulberry32` generator to get a reproducible permutation.
 * @returns `arr` itself, for chaining — no copy is made.
 */
export function shuffle<T>(arr: T[], rand: () => number): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    // oxlint-disable-next-line typescript/no-non-null-assertion -- i and j are within bounds by construction
    const tmp = arr[i]!;
    // oxlint-disable-next-line typescript/no-non-null-assertion -- j ∈ [0, i] by Math.floor(rand() * (i+1))
    arr[i] = arr[j]!;
    arr[j] = tmp;
  }
  return arr;
}
