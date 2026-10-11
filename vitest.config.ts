import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    restoreMocks: true,
    unstubEnvs: true,
    unstubGlobals: true,
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
        test: {
          name: "unit",
          include: ["tests/unit/**/*.test.ts", "tests/benchmarks/**/*.test.ts"],
        },
      },
    ],
  },
});
