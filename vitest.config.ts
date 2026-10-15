import { defineConfig } from "vitest/config";

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
    projects: [
      {
        test: {
          name: "types",
          include: [],
          typecheck: {
            enabled: true,
            include: ["tests/types/**/*.test-d.ts"],
          },
        },
      },
      {
        // Tests and benchmark modules import the package by name. The `paths` in `tests/` and
        // `benchmarks/` tsconfigs resolve that name to the sources, not to the `dist/` the
        // package's `exports` point at, so tests never run against a stale or missing build.
        // Without this, the name still resolves, to `dist/`, and the tests pass against whatever
        // was last built. The root tsconfig carries no `paths`: tsx reads it, and the benchmark
        // suite must measure `dist/`.
        resolve: { tsconfigPaths: true },
        test: {
          name: "unit",
          include: ["tests/unit/**/*.test.ts", "tests/benchmarks/**/*.test.ts"],
        },
      },
    ],
  },
});
