/**
 * Debug gate: compile-time stripping of debug checks via NDEBUG build define.
 *
 * When process.env.NDEBUG is defined, all `if (DEBUG)` blocks compile out.
 * Checks include entity storage validation, generation mismatches, and other
 * safety invariants. In production builds, these vanish without side effects.
 */

/** When `true`, entity validation checks (staleness, wrong-storage) are active. Set to `false` by defining `process.env.NDEBUG`. */
export const DEBUG = process.env.NDEBUG === undefined;
