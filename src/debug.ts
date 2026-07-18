/**
 * Debug gate: compile-time stripping of debug checks via NDEBUG build define.
 *
 * When process.env.NDEBUG is defined, all `if (DEBUG)` blocks compile out.
 * Checks include entity storage validation, generation mismatches, and other
 * safety invariants. In production builds, these vanish without side effects.
 */

export const DEBUG = process.env.NDEBUG === undefined;
