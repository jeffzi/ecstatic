import { configDefaults, defineConfig } from "vitest/config";

import ecstatic from "./src/plugin/vite.js";
import { goldenLoader } from "./tests/optimizer/golden-loader.js";

const FIXTURE_TESTS = ["tests/optimizer/**/*.test.ts"];
const UNIT_TESTS = ["tests/unit/**/*.test.ts"];
// The optimizer's and the plugin's own tests drive the optimizer directly, so an optimized project
// leaves them out and runs only the tests of the runtime it rewrites.
const OPTIMIZED_UNIT_EXCLUDE = [
  ...configDefaults.exclude,
  "tests/unit/optimizer/**",
  "tests/unit/plugin/**",
];
// Each plugin instance starts one compiler process for the run, so every optimized project calls
// `ecstatic()` itself: a shared instance would end its process when the first project closes.
const OPTIMIZER_OPTIONS = { project: "tests/tsconfig.json" };
// Tests and benchmark modules import the package by name. The `paths` in `tests/` and `benchmarks/`
// tsconfigs resolve that name to the sources, not to the `dist/` the package's `exports` point at,
// so tests never run against a stale or missing build. Without this, the name still resolves, to
// `dist/`, and the tests pass against whatever was last built. The root tsconfig carries no `paths`:
// tsx reads it, and the benchmark suite must measure `dist/`.
const SOURCE_RESOLVE = { tsconfigPaths: true };

export default defineConfig({
  test: {
    allowOnly: false,
    expect: { requireAssertions: true },
    restoreMocks: true,
    unstubEnvs: true,
    unstubGlobals: true,
    sequence: {
      shuffle: {
        files: true,
        tests: true,
      },
    },
    coverage: {
      provider: "istanbul",
      include: ["src/**/*.ts"],
      thresholds: {
        lines: 95,
        functions: 95,
        branches: 95,
        statements: 95,
      },
    },
    // An inline project builds its test options from its own `test` block alone, so every project
    // sets `extends: true` to inherit the options above.
    projects: [
      {
        extends: true,
        test: {
          name: "types",
          include: [],
          typecheck: {
            enabled: true,
            include: ["tests/types/**/*.test-d.ts"],
            // `tsc` checks the files the tsconfig includes, not the test files Vitest matched; the
            // root tsconfig leaves `tests/` out, so every type assertion would pass unchecked.
            tsconfig: "tests/tsconfig.json",
          },
        },
      },
      {
        extends: true,
        resolve: SOURCE_RESOLVE,
        test: {
          name: "unit",
          include: [...UNIT_TESTS, "tests/benchmarks/**/*.test.ts"],
        },
      },
      {
        extends: true,
        resolve: SOURCE_RESOLVE,
        plugins: [ecstatic(OPTIMIZER_OPTIONS)],
        test: { name: "unit-optimized", include: UNIT_TESTS, exclude: OPTIMIZED_UNIT_EXCLUDE },
      },
      {
        extends: true,
        resolve: SOURCE_RESOLVE,
        plugins: [ecstatic(OPTIMIZER_OPTIONS)],
        define: { NDEBUG: "true" },
        test: {
          name: "unit-ndebug",
          include: UNIT_TESTS,
          exclude: OPTIMIZED_UNIT_EXCLUDE,
          setupFiles: ["tests/skip-checked.ts"],
        },
      },
      {
        extends: true,
        resolve: SOURCE_RESOLVE,
        plugins: [goldenLoader()],
        test: { name: "fixtures", include: FIXTURE_TESTS },
      },
      {
        extends: true,
        resolve: SOURCE_RESOLVE,
        plugins: [goldenLoader()],
        define: { NDEBUG: "true" },
        test: {
          name: "fixtures-ndebug",
          include: FIXTURE_TESTS,
          // The corpus test runs the optimizer in Node, where NDEBUG changes nothing. The Vite smoke
          // test's builds run in a child process the NDEBUG define never reaches, so an NDEBUG run
          // only repeats them.
          exclude: [
            ...configDefaults.exclude,
            "tests/optimizer/corpus.test.ts",
            "tests/optimizer/vite-smoke.test.ts",
          ],
        },
      },
    ],
  },
});
