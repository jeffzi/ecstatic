import { describe, expect, it } from "vitest";

import {
  anchoredFilter,
  type BenchEntry,
  type BenchReport,
  benchNames,
  ChildReportError,
  type ChildSpawnSpec,
  childSpawnSpec,
  type Engine,
  mergeReports,
  type ParsedArgs,
  parseArgs,
  parseChildReport,
  registerBench,
  selectBenchmarks,
  UsageError,
} from "../benchmarks/runner.js";

const FILTER = "^access\\.";
const BENCH = "access.get_1field";

describe("parseArgs", () => {
  describe("in parent mode", () => {
    it("defaults to the node engine with no filter when argv is empty", () => {
      const parsed = parseArgs([]);

      expect(parsed).toStrictEqual({ mode: "parent", engine: "node" });
    });

    it("reads a lone positional argument as the filter", () => {
      const parsed = parseArgs([FILTER]);

      expect(parsed).toStrictEqual({ mode: "parent", filter: FILTER, engine: "node" });
    });

    const engineCases: { label: string; argv: string[]; expected: ParsedArgs }[] = [
      {
        label: "on its own",
        argv: ["--engine", "bun"],
        expected: { mode: "parent", engine: "bun" },
      },
      {
        label: "after the filter",
        argv: [FILTER, "--engine", "bun"],
        expected: { mode: "parent", filter: FILTER, engine: "bun" },
      },
      {
        label: "before the filter",
        argv: ["--engine", "bun", FILTER],
        expected: { mode: "parent", filter: FILTER, engine: "bun" },
      },
      {
        label: "naming the default engine",
        argv: ["--engine", "node"],
        expected: { mode: "parent", engine: "node" },
      },
    ];

    it.each(engineCases)("reads --engine $label", ({ argv, expected }) => {
      const parsed = parseArgs(argv);

      expect(parsed).toStrictEqual(expected);
    });
  });

  describe("in child mode", () => {
    it("takes the --child value as an exact benchmark name", () => {
      const parsed = parseArgs(["--child", BENCH]);

      expect(parsed).toStrictEqual({ mode: "child", benchName: BENCH });
    });
  });

  describe("when the command line is malformed", () => {
    const usageCases: { label: string; argv: string[] }[] = [
      { label: "--engine without a value", argv: ["--engine"] },
      { label: "an unknown engine", argv: ["--engine", "deno"] },
      { label: "an unknown flag", argv: ["--verbose"] },
      { label: "two positional arguments", argv: [FILTER, "^entity\\."] },
      { label: "--child without a value", argv: ["--child"] },
      { label: "--child alongside a filter", argv: [FILTER, "--child", BENCH] },
      { label: "--child alongside --engine", argv: ["--child", BENCH, "--engine", "bun"] },
    ];

    it.each(usageCases)("throws UsageError for $label", ({ argv }) => {
      expect(() => parseArgs(argv)).toThrow(UsageError);
    });
  });
});

describe("childSpawnSpec", () => {
  const target = {
    execPath: "/usr/bin/node",
    mainPath: "/repo/benchmarks/main.ts",
    benchName: BENCH,
  };

  const spawnCases: { engine: Engine; expected: ChildSpawnSpec }[] = [
    {
      engine: "node",
      // The node binary is invoked directly with `--import tsx`, skipping the
      // tsx wrapper's re-exec hop.
      expected: {
        command: target.execPath,
        args: ["--expose-gc", "--import", "tsx", target.mainPath, "--child", target.benchName],
      },
    },
    {
      engine: "bun",
      expected: {
        command: "bun",
        args: ["--expose-gc", target.mainPath, "--child", target.benchName],
      },
    },
  ];

  it.each(spawnCases)("builds the $engine command", ({ engine, expected }) => {
    const spec = childSpawnSpec(engine, target);

    expect(spec).toStrictEqual(expected);
  });
});

describe("registerBench", () => {
  // The registry is module-level state shared by the whole file, so each test
  // owns a private name prefix and only asserts on its own entries.
  const body = (): number => 1;

  it("records names in registration order", () => {
    registerBench("order.first", body);
    registerBench("order.second", body);
    registerBench("order.third", body);

    const recorded = benchNames().filter((name) => name.startsWith("order."));

    expect(recorded).toStrictEqual(["order.first", "order.second", "order.third"]);
  });

  it("rejects a name that is already registered", () => {
    registerBench("duplicate.only", body);

    expect(() => {
      registerBench("duplicate.only", body);
    }).toThrow(/duplicate\.only/);
  });
});

describe("anchoredFilter", () => {
  const matchCases: { candidate: string; matches: boolean }[] = [
    { candidate: BENCH, matches: true },
    { candidate: `${BENCH}_extra`, matches: false },
    { candidate: "access.get", matches: false },
    // The `.` in the name must be escaped, or it would match any character.
    { candidate: "access:get_1field", matches: false },
  ];

  it.each(matchCases)(
    "built from the name matches $candidate → $matches",
    ({ candidate, matches }) => {
      const pattern = new RegExp(anchoredFilter(BENCH));

      expect(pattern.test(candidate)).toBe(matches);
    },
  );
});

describe("selectBenchmarks", () => {
  const NAMES: readonly string[] = [
    "access.get_1field",
    "access.get_3fields",
    "iteration.each_soa",
    "entity.spawn",
  ];

  it("returns every name when no filter is given", () => {
    const selected = selectBenchmarks(NAMES);

    expect(selected).toStrictEqual([
      "access.get_1field",
      "access.get_3fields",
      "iteration.each_soa",
      "entity.spawn",
    ]);
  });

  const filterCases: { label: string; filter: string; expected: string[] }[] = [
    {
      label: "an anchored prefix, preserving order",
      filter: FILTER,
      expected: ["access.get_1field", "access.get_3fields"],
    },
    { label: "an unanchored substring", filter: "soa", expected: ["iteration.each_soa"] },
    { label: "a pattern matching nothing", filter: "^nope", expected: [] },
  ];

  it.each(filterCases)("selects $label", ({ filter, expected }) => {
    const selected = selectBenchmarks(NAMES, filter);

    expect(selected).toStrictEqual(expected);
  });

  it("throws UsageError for an invalid regex", () => {
    expect(() => selectBenchmarks(NAMES, "[")).toThrow(UsageError);
  });
});

const LAYOUT: unknown = [{ name: 0, types: [] }];
const CONTEXT: unknown = { cpu: { freq: 3.2 }, runtime: "node" };

/**
 * One benchmark entry as mitata's json format writes it.
 *
 * `stats`, `args` and `kind` are fields the runner never reads — they are here
 * so the tests can prove they survive parsing and merging.
 */
function benchEntry(alias: string, overrides: Partial<BenchEntry> = {}): BenchEntry {
  return {
    alias,
    runs: [{ stats: { p50: 1234.5, heap: { avg: 64 } }, args: { size: 1000 }, error: null }],
    kind: "iter",
    ...overrides,
  };
}

function report(overrides: Partial<BenchReport> = {}): BenchReport {
  return { layout: LAYOUT, benchmarks: [benchEntry(BENCH)], context: CONTEXT, ...overrides };
}

describe("parseChildReport", () => {
  describe("when stdout carries one valid report", () => {
    it("returns the document with every field preserved", () => {
      const document = report();

      const parsed = parseChildReport(JSON.stringify(document));

      expect(parsed).toStrictEqual(document);
    });

    const junkCases: { label: string; stdout: (json: string) => string }[] = [
      { label: "a progress line printed before it", stdout: (json) => `[1/27] ${BENCH}\n${json}` },
      { label: "noise printed after it", stdout: (json) => `${json}\ndone in 3.2s\n` },
      { label: "noise on both sides", stdout: (json) => `warming up\n${json}\nbye\n` },
    ];

    it.each(junkCases)("parses the document despite $label", ({ stdout }) => {
      const document = report();

      const parsed = parseChildReport(stdout(JSON.stringify(document)));

      expect(parsed).toStrictEqual(document);
    });
  });

  describe("when stdout is not a usable report", () => {
    const failingRun = { stats: { p50: 0 }, error: "field 'hp' is not defined" };

    const invalidCases: { label: string; stdout: string }[] = [
      { label: "output holding no JSON at all", stdout: "bun: command not found\n" },
      { label: "an empty benchmarks array", stdout: JSON.stringify(report({ benchmarks: [] })) },
      {
        label: "two benchmark entries",
        stdout: JSON.stringify(
          report({ benchmarks: [benchEntry(BENCH), benchEntry("access.get_3fields")] }),
        ),
      },
      {
        label: "a run recording an error",
        stdout: JSON.stringify(report({ benchmarks: [benchEntry(BENCH, { runs: [failingRun] })] })),
      },
      {
        label: "a document without layout",
        stdout: JSON.stringify({ benchmarks: [benchEntry(BENCH)], context: CONTEXT }),
      },
      {
        label: "a document without context",
        stdout: JSON.stringify({ layout: LAYOUT, benchmarks: [benchEntry(BENCH)] }),
      },
    ];

    it.each(invalidCases)("throws ChildReportError for $label", ({ stdout }) => {
      expect(() => parseChildReport(stdout)).toThrow(ChildReportError);
    });
  });
});

describe("mergeReports", () => {
  describe("when given several reports", () => {
    const first = report({ benchmarks: [benchEntry("access.get_1field")] });
    const second = report({
      benchmarks: [benchEntry("entity.spawn")],
      layout: [{ name: 1, types: [] }],
      context: { cpu: { freq: 1.1 }, runtime: "bun" },
    });
    const third = report({ benchmarks: [benchEntry("iteration.each_soa")] });

    it("concatenates the benchmark entries in input order", () => {
      const merged = mergeReports([first, second, third]);

      expect(merged.benchmarks.map((entry) => entry.alias)).toStrictEqual([
        "access.get_1field",
        "entity.spawn",
        "iteration.each_soa",
      ]);
    });

    it("takes layout and context from the first report", () => {
      const merged = mergeReports([first, second, third]);

      expect({ layout: merged.layout, context: merged.context }).toStrictEqual({
        layout: LAYOUT,
        context: CONTEXT,
      });
    });

    it("carries each entry's nested run stats through unchanged", () => {
      const merged = mergeReports([first, second, third]);

      expect(merged.benchmarks).toStrictEqual([
        benchEntry("access.get_1field"),
        benchEntry("entity.spawn"),
        benchEntry("iteration.each_soa"),
      ]);
    });
  });

  it("returns an equivalent document for a single report", () => {
    const only = report();

    const merged = mergeReports([only]);

    expect(merged).toStrictEqual(only);
  });

  const failingCases: { label: string; reports: BenchReport[] }[] = [
    { label: "no reports at all", reports: [] },
    {
      label: "two reports sharing a benchmark alias",
      reports: [report(), report({ context: { runtime: "bun" } })],
    },
  ];

  it.each(failingCases)("throws ChildReportError for $label", ({ reports }) => {
    expect(() => mergeReports(reports)).toThrow(ChildReportError);
  });
});
