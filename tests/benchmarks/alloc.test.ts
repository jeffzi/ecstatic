import { describe, expect, it } from "vitest";

import {
  ALLOC_BUDGETS,
  allocGatePasses,
  type AllocResult,
  type AllocVerdict,
  EPSILON_BYTES,
  evaluateAlloc,
  formatAllocReport,
} from "../../benchmarks/alloc/budgets.js";

const BUDGET = 100;
const EPSILON = 8;

function allocResult(overrides: Partial<AllocResult> = {}): AllocResult {
  return { name: "each_all", measured: 0, budget: 0, verdict: "ok", ...overrides };
}

/** Non-empty report lines, in order. */
function reportLines(report: string): string[] {
  return report.split("\n").filter((line) => line.trim() !== "");
}

/**
 * Whitespace-separated tokens of the line whose first token is `name`, or `[]`
 * when no line names that op. Column padding is presentation, so the tests read
 * tokens rather than exact spacing.
 */
function tokensFor(report: string, name: string): string[] {
  const line = reportLines(report).find((candidate) => candidate.trim().split(/\s+/)[0] === name);

  return line === undefined ? [] : line.trim().split(/\s+/);
}

describe("ALLOC_BUDGETS", () => {
  it("gives every gated op a finite non-negative byte budget", () => {
    const invalid = Object.entries(ALLOC_BUDGETS).filter(
      ([, bytes]) => !Number.isFinite(bytes) || bytes < 0,
    );

    expect(invalid).toStrictEqual([]);
  });

  it("gates the iteration, access and entity hot paths", () => {
    const gated = new Set(Object.keys(ALLOC_BUDGETS));

    const missing = ["each_all", "get_1field", "spawn_despawn"].filter((op) => !gated.has(op));

    expect(missing).toStrictEqual([]);
  });
});

describe("EPSILON_BYTES", () => {
  it("tolerates a single tagged-pointer slot of measurement noise", () => {
    expect(EPSILON_BYTES).toBe(EPSILON);
  });
});

describe("evaluateAlloc", () => {
  describe("when an op is both measured and budgeted", () => {
    const verdictCases: { label: string; measured: number; verdict: AllocVerdict }[] = [
      {
        label: "one byte above the epsilon ceiling",
        measured: BUDGET + EPSILON + 1,
        verdict: "over",
      },
      { label: "exactly at the epsilon ceiling", measured: BUDGET + EPSILON, verdict: "ok" },
      { label: "exactly on budget", measured: BUDGET, verdict: "ok" },
      { label: "exactly at the epsilon floor", measured: BUDGET - EPSILON, verdict: "ok" },
      {
        label: "one byte below the epsilon floor",
        measured: BUDGET - EPSILON - 1,
        verdict: "slack",
      },
    ];

    it.each(verdictCases)("reports $verdict for a measurement $label", ({ measured, verdict }) => {
      const results = evaluateAlloc({ each_all: measured }, { each_all: BUDGET }, EPSILON);

      expect(results).toStrictEqual([{ name: "each_all", measured, budget: BUDGET, verdict }]);
    });
  });

  it("reports unbudgeted for an op that is measured but has no budget", () => {
    const results = evaluateAlloc({ each_all: 42 }, {}, EPSILON);

    expect(results).toStrictEqual([
      { name: "each_all", measured: 42, budget: undefined, verdict: "unbudgeted" },
    ]);
  });

  it("reports unmeasured for an op that is budgeted but never measured", () => {
    const results = evaluateAlloc({}, { each_all: BUDGET }, EPSILON);

    expect(results).toStrictEqual([
      { name: "each_all", measured: undefined, budget: BUDGET, verdict: "unmeasured" },
    ]);
  });

  it("returns no results when there is nothing measured and nothing budgeted", () => {
    const results = evaluateAlloc({}, {}, EPSILON);

    expect(results).toStrictEqual([]);
  });

  it("orders budgeted ops by the budget table, then unbudgeted ops by measurement", () => {
    const results = evaluateAlloc(
      { zeta: 1, get_1field: 0, alpha: 2, each_all: 0 },
      { each_all: 0, get_1field: 0, has: 0 },
      EPSILON,
    );

    expect(results.map((result) => result.name)).toStrictEqual([
      "each_all",
      "get_1field",
      "has",
      "zeta",
      "alpha",
    ]);
  });
});

describe("allocGatePasses", () => {
  const gateCases: { label: string; results: AllocResult[]; passes: boolean }[] = [
    { label: "no results at all", results: [], passes: true },
    {
      label: "only ok verdicts",
      results: [allocResult(), allocResult({ name: "has" })],
      passes: true,
    },
    {
      label: "an over verdict",
      results: [allocResult(), allocResult({ name: "has", measured: 64, verdict: "over" })],
      passes: false,
    },
    {
      label: "a slack verdict",
      results: [allocResult({ budget: 64, verdict: "slack" })],
      passes: false,
    },
    {
      label: "an unbudgeted verdict",
      results: [allocResult({ budget: undefined, verdict: "unbudgeted" })],
      passes: false,
    },
    {
      label: "an unmeasured verdict",
      results: [allocResult({ measured: undefined, verdict: "unmeasured" })],
      passes: false,
    },
  ];

  it.each(gateCases)("returns $passes for $label", ({ results, passes }) => {
    expect(allocGatePasses(results)).toBe(passes);
  });
});

describe("formatAllocReport", () => {
  it("renders name, measured bytes, budget and verdict for a measured op", () => {
    const report = formatAllocReport([
      allocResult({ name: "each_all", measured: 24, budget: 32, verdict: "slack" }),
    ]);

    expect(tokensFor(report, "each_all")).toStrictEqual(["each_all", "24", "32", "slack"]);
  });

  const dashCases: { label: string; result: AllocResult; expectedTokens: string[] }[] = [
    {
      label: "a missing measurement",
      result: allocResult({ name: "has", measured: undefined, budget: 16, verdict: "unmeasured" }),
      expectedTokens: ["has", "-", "16", "unmeasured"],
    },
    {
      label: "a missing budget",
      result: allocResult({ name: "alive", measured: 8, budget: undefined, verdict: "unbudgeted" }),
      expectedTokens: ["alive", "8", "-", "unbudgeted"],
    },
  ];

  it.each(dashCases)("renders a dash for $label", ({ result, expectedTokens }) => {
    const report = formatAllocReport([result]);

    expect(tokensFor(report, result.name)).toStrictEqual(expectedTokens);
  });

  it("renders one line per op, in result order, above the closing line", () => {
    const report = formatAllocReport([
      allocResult({ name: "each_all" }),
      allocResult({ name: "has" }),
      allocResult({ name: "alive" }),
    ]);

    const opNames = reportLines(report)
      .slice(0, -1)
      .map((line) => line.trim().split(/\s+/)[0]);

    expect(opNames).toStrictEqual(["each_all", "has", "alive"]);
  });

  const passCases: { label: string; results: AllocResult[] }[] = [
    { label: "no results at all", results: [] },
    { label: "only ok verdicts", results: [allocResult(), allocResult({ name: "has" })] },
  ];

  it.each(passCases)("closes with a pass line for $label", ({ results }) => {
    const report = formatAllocReport(results);

    expect(reportLines(report).at(-1)).toBe("alloc gate: pass");
  });

  it("closes with a fail line naming every non-ok op in result order", () => {
    const report = formatAllocReport([
      allocResult({ name: "each_all", measured: 64, verdict: "over" }),
      allocResult({ name: "has" }),
      allocResult({ name: "alive", budget: 64, verdict: "slack" }),
      allocResult({ name: "spawn_despawn", budget: undefined, verdict: "unbudgeted" }),
      allocResult({ name: "rel_link", measured: undefined, verdict: "unmeasured" }),
    ]);

    expect(reportLines(report).at(-1)).toBe(
      "alloc gate: FAIL — each_all, alive, spawn_despawn, rel_link",
    );
  });
});
