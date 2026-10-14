import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

/**
 * Benchmark modules import the package by name. Tests resolve that name to the
 * sources, not to the `dist/` the package's `exports` point at, so they never
 * run against a stale or missing build.
 */
const ecstaticSource = fileURLToPath(new URL("src/index.ts", import.meta.url));

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
        resolve: {
          alias: [{ find: /^ecstatic$/, replacement: ecstaticSource }],
        },
        test: {
          name: "unit",
          include: ["tests/unit/**/*.test.ts", "tests/benchmarks/**/*.test.ts"],
        },
      },
    ],
  },
});
