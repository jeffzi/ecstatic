import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.d.ts"],
      thresholds: {
        lines: 95,
        functions: 95,
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
          include: ["tests/**/*.test.ts"],
        },
      },
    ],
  },
});
