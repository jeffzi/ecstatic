import type { PartialStrykerOptions } from "@stryker-mutator/api/core";

// Mutation testing for the optimizer's hazard analysis, run by `npm run check:mutation`. The Vitest
// runner's related mode runs every test, in any project of `vitest.config.ts`, whose imports reach
// `hazard.ts`; the runner turns coverage off, so the coverage thresholds never fail a mutant's run.
export default {
  testRunner: "vitest",
  vitest: { configFile: "vitest.config.ts" },
  mutate: ["src/plugin/optimizer/analysis/hazard.ts"],
  coverageAnalysis: "perTest",
  reporters: ["progress-append-only", "clear-text"],
  dryRunTimeoutMinutes: 30,
  // Longer than every Vitest test and hook timeout the covering tests set (60 s at most), so a mutant
  // that stalls a test fails in Vitest and counts as killed by that test, and one that only slows
  // the run down finishes and is judged by its assertions. Only a run that never ends times out.
  timeoutMS: 90_000,
  ignorePatterns: ["dist", "coverage", ".research", ".planning", "benchmarks"],
  // Stryker rewrites the sandbox's tsconfig `extends` and `references` through the TypeScript 5 API,
  // which TypeScript 7 does not have. Every tsconfig here extends one inside the repository, which
  // the sandbox copies whole, so naming a tsconfig no file has skips a rewrite that would change
  // nothing.
  tsconfigFile: "no-tsconfig-rewrite.json",
  thresholds: { high: 100, low: 90, break: 100 },
} satisfies PartialStrykerOptions;
