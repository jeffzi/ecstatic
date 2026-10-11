import { describe, expect, it } from "vitest";

import { mulberry32, shuffle } from "../../benchmarks/random.js";

/** Draws `count` successive values from `rand`. */
function take(rand: () => number, count: number): number[] {
  return Array.from({ length: count }, () => rand());
}

/** The integers 0 through `count - 1`, ascending. */
function range(count: number): number[] {
  return Array.from({ length: count }, (_, index) => index);
}

/** A numerically ascending copy of `values`. */
function ascending(values: number[]): number[] {
  return values.toSorted((a, b) => a - b);
}

/**
 * A stand-in generator replaying `values`, so a shuffle's swap indices are exactly known.
 *
 * Exhaustion throws rather than wrapping around: a shuffle that draws more
 * values than the script holds is reporting that it makes a different number of
 * draws than expected, and recycling the script would hide that behind a
 * mismatched permutation.
 *
 * @param values - The draws to replay, in order.
 * @returns A generator yielding each entry of `values` once.
 * @throws Error when called more times than `values` holds.
 */
function scripted(values: number[]): () => number {
  let index = 0;
  return () => {
    const value = values[index];
    if (value === undefined) {
      throw new Error(`drew more values than scripted (${String(values.length)})`);
    }
    index += 1;
    return value;
  };
}

const SEED = 2024;

describe("mulberry32", () => {
  it("emits values spread across [0, 1)", () => {
    const values = take(mulberry32(0xc0ffee), 1000);

    expect(Math.min(...values)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...values)).toBeLessThan(1);
    // A generator clamped to a narrow sub-range would satisfy the bounds above
    // while being useless to shuffle, so pin the spread too.
    expect(Math.min(...values)).toBeLessThan(0.1);
    expect(Math.max(...values)).toBeGreaterThan(0.9);
  });

  it("emits the same sequence for the same seed", () => {
    const first = take(mulberry32(42), 16);
    const second = take(mulberry32(42), 16);

    expect(first).toStrictEqual(second);
  });

  it("emits a different sequence for a different seed", () => {
    const first = take(mulberry32(42), 16);
    const second = take(mulberry32(43), 16);

    expect(first).not.toStrictEqual(second);
  });

  it("advances its state between calls", () => {
    const rand = mulberry32(42);

    const [first, second] = take(rand, 2);

    expect(second).not.toBe(first);
  });
});

describe("shuffle", () => {
  it("returns the array it was given", () => {
    const arr = range(32);

    const result = shuffle(arr, mulberry32(SEED));

    expect(result).toBe(arr);
  });

  it("returns a reordering of the same elements", () => {
    const arr = range(32);

    const result = shuffle(arr, mulberry32(SEED));

    expect(ascending(result)).toStrictEqual(range(32));
    expect(result).not.toStrictEqual(range(32));
  });

  // The benchmark suite needs a given seed to lay entities out identically on
  // every run, which makes the whole stream-to-permutation mapping the
  // contract — not just "some permutation". Pinning one exact trace is what
  // detects a change to it, including drawing from a different swap range.
  it("maps a scripted draw sequence to a pinned permutation", () => {
    const arr = range(4);

    const result = shuffle(arr, scripted([0.5, 0, 0.99]));

    expect(result).toStrictEqual([3, 1, 0, 2]);
  });

  const noOpCases: { label: string; input: number[] }[] = [
    { label: "empty", input: [] },
    { label: "single-element", input: [7] },
  ];

  it.each(noOpCases)("leaves a $label array unchanged", ({ input }) => {
    const arr = [...input];

    const result = shuffle(arr, mulberry32(SEED));

    expect(result).toStrictEqual(input);
  });
});
