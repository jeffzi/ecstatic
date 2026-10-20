import { configDefaults, defineConfig } from "vitest/config";

import { goldenLoader } from "./tests/optimizer/golden-loader.js";

const FIXTURE_TESTS = ["tests/optimizer/**/*.test.ts"];
const UNIT_TESTS = ["tests/unit/**/*.test.ts"];
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
        define: { NDEBUG: "true" },
        test: { name: "unit-ndebug", include: UNIT_TESTS, setupFiles: ["tests/skip-checked.ts"] },
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
          // The corpus test runs the optimizer in Node, where NDEBUG changes nothing.
          exclude: [...configDefaults.exclude, "tests/optimizer/corpus.test.ts"],
        },
      },
    ],
  },
});
