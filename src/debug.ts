/**
 * Debug gate: compile-time stripping of debug checks via an `NDEBUG` build define.
 *
 * Bundlers (esbuild, Vite, Rollup) can constant-fold `if (DEBUG)` blocks away
 * with `define: { NDEBUG: "true" }`. Without a bundler, set `globalThis.NDEBUG`
 * before any import of this module to disable checks at runtime.
 *
 * Checks include entity storage validation, generation mismatches, and other
 * safety invariants. In production builds, these vanish without side effects.
 */

declare const NDEBUG: boolean | undefined;

/** When `true`, entity validation checks (staleness, wrong-storage) are active. Disabled by defining `NDEBUG` via a bundler define or by setting `globalThis.NDEBUG` before import. */
export const DEBUG = typeof NDEBUG === "undefined" || !NDEBUG;
