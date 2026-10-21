import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  anchoredFilter,
  type BenchEntry,
  type BenchReport,
  benchNames,
  ChildReportError,
  type ChildSpawnSpec,
  childSpawnSpec,
  CompileError,
  compileOptimized,
  type Engine,
  isDefaultEngines,
  mergeReports,
  namespaceReport,
  type ParsedArgs,
  parseArgs,
  parseChildReport,
  parseGeneration,
  registerBench,
  selectBenchmarks,
  UsageError,
} from "../../benchmarks/runner.js";
import { openSession, type Session } from "../../src/plugin/optimizer/session.js";
import { createProject, removeTempDirs } from "../unit/plugin/tsconfig-fixtures.js";
import {
  BENCHMARK_CONFIG,
  benchmarkConfigProject,
  COMPILE_FAILURES,
  COMPILE_TIMEOUT_MS,
  removeBenchmarkProjects,
} from "./fixtures.js";

const FILTER = "^access\\.";
const BENCH = "access.get_1field";

describe("parseArgs", () => {
  describe("in parent mode", () => {
    it("defaults to the node engine with no filter when argv is empty", () => {
      const parsed = parseArgs([]);

      expect(parsed).toStrictEqual({ mode: "parent", engines: ["node"], optimized: false });
    });

    it("reads a lone positional argument as the filter", () => {
      const parsed = parseArgs([FILTER]);

      expect(parsed).toStrictEqual({
        mode: "parent",
        filter: FILTER,
        engines: ["node"],
        optimized: false,
      });
    });

    const engineCases: { label: string; argv: string[]; expected: ParsedArgs }[] = [
      {
        label: "a single engine on its own",
        argv: ["--engine", "bun"],
        expected: { mode: "parent", engines: ["bun"], optimized: false },
      },
      {
        label: "a single engine after the filter",
        argv: [FILTER, "--engine", "bun"],
        expected: { mode: "parent", filter: FILTER, engines: ["bun"], optimized: false },
      },
      {
        label: "a single engine before the filter",
        argv: ["--engine", "bun", FILTER],
        expected: { mode: "parent", filter: FILTER, engines: ["bun"], optimized: false },
      },
      {
        label: "the default engine by name",
        argv: ["--engine", "node"],
        expected: { mode: "parent", engines: ["node"], optimized: false },
      },
      {
        label: "two engines comma-separated",
        argv: ["--engine", "node,bun"],
        expected: { mode: "parent", engines: ["node", "bun"], optimized: false },
      },
      {
        label: "two engines comma-separated with a filter",
        argv: [FILTER, "--engine", "node,bun"],
        expected: { mode: "parent", filter: FILTER, engines: ["node", "bun"], optimized: false },
      },
    ];

    it.each(engineCases)("parses --engine with $label", ({ argv, expected }) => {
      const parsed = parseArgs(argv);

      expect(parsed).toStrictEqual(expected);
    });

    const optimizedCases: { label: string; argv: string[]; expected: ParsedArgs }[] = [
      {
        label: "on its own",
        argv: ["--optimized"],
        expected: { mode: "parent", engines: ["node"], optimized: true },
      },
      {
        label: "before the other arguments",
        argv: ["--optimized", "--engine", "bun", FILTER],
        expected: { mode: "parent", filter: FILTER, engines: ["bun"], optimized: true },
      },
      {
        label: "between the other arguments",
        argv: ["--engine", "node,bun", "--optimized", FILTER],
        expected: { mode: "parent", filter: FILTER, engines: ["node", "bun"], optimized: true },
      },
      {
        label: "after the other arguments",
        argv: [FILTER, "--engine", "bun", "--optimized"],
        expected: { mode: "parent", filter: FILTER, engines: ["bun"], optimized: true },
      },
    ];

    it.each(optimizedCases)("parses --optimized $label", ({ argv, expected }) => {
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
      { label: "an unknown engine in a comma list", argv: ["--engine", "node,deno"] },
      { label: "an empty item with trailing comma", argv: ["--engine", "node,"] },
      { label: "an empty item with leading comma", argv: ["--engine", ",bun"] },
      { label: "a duplicate engine", argv: ["--engine", "node,node"] },
      { label: "a repeated --engine flag", argv: ["--engine", "node", "--engine", "bun"] },
      { label: "an unknown flag", argv: ["--verbose"] },
      { label: "two positional arguments", argv: [FILTER, "^entity\\."] },
      { label: "--child without a value", argv: ["--child"] },
      { label: "--child alongside a filter", argv: [FILTER, "--child", BENCH] },
      { label: "--child alongside --engine", argv: ["--child", BENCH, "--engine", "bun"] },
      { label: "--child alongside --optimized", argv: ["--child", BENCH, "--optimized"] },
      { label: "a repeated --optimized flag", argv: ["--optimized", "--optimized"] },
    ];

    it.each(usageCases)("throws UsageError for $label", ({ argv }) => {
      expect(() => parseArgs(argv)).toThrow(UsageError);
    });
  });
});

describe("parseGeneration", () => {
  it("returns generation 1 when the variable is unset", () => {
    const generation = parseGeneration(undefined);

    expect(generation).toBe(1);
  });

  const validCases: { raw: string; expected: number }[] = [
    { raw: "1", expected: 1 },
    { raw: "2", expected: 2 },
    { raw: "131", expected: 131 },
    { raw: "1023", expected: 1023 },
  ];

  it.each(validCases)("reads $raw as generation $expected", ({ raw, expected }) => {
    const generation = parseGeneration(raw);

    expect(generation).toBe(expected);
  });

  describe("when the value is not an integer from 1 to 1023", () => {
    const invalidCases: { label: string; raw: string }[] = [
      { label: "an empty string", raw: "" },
      { label: "zero", raw: "0" },
      { label: "a negative integer", raw: "-3" },
      { label: "an integer above 1023", raw: "1024" },
      { label: "a non-integer", raw: "1.5" },
      { label: "non-numeric text", raw: "banana" },
      { label: "digits with trailing junk", raw: "131x" },
    ];

    it.each(invalidCases)("throws UsageError for $label", ({ raw }) => {
      expect(() => parseGeneration(raw)).toThrow(UsageError);
    });

    it.each(invalidCases)("names the variable and the value for $label", ({ raw }) => {
      const parse = (): number => parseGeneration(raw);

      expect(parse).toThrow("BENCH_GENERATION");
      expect(parse).toThrow(`"${raw}"`);
    });
  });
});

describe("isDefaultEngines", () => {
  const cases: { engines: Engine[]; expected: boolean }[] = [
    { engines: ["node"], expected: true },
    { engines: ["bun"], expected: false },
    { engines: ["node", "bun"], expected: false },
  ];

  it.each(cases)("returns $expected for $engines", ({ engines, expected }) => {
    expect(isDefaultEngines(engines)).toBe(expected);
  });
});

describe("childSpawnSpec", () => {
  const target = {
    execPath: "/usr/bin/node",
    mainPath: "/repo/benchmarks/main.ts",
    benchName: BENCH,
    compiled: false,
  };

  const compiledTarget = {
    ...target,
    mainPath: "/repo/.bench-optimized/benchmarks/main.js",
    compiled: true,
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

  const compiledCases: { engine: Engine; expected: ChildSpawnSpec }[] = [
    {
      engine: "node",
      expected: {
        command: compiledTarget.execPath,
        args: ["--expose-gc", compiledTarget.mainPath, "--child", compiledTarget.benchName],
      },
    },
    {
      engine: "bun",
      expected: {
        command: "bun",
        args: ["--expose-gc", compiledTarget.mainPath, "--child", compiledTarget.benchName],
      },
    },
  ];

  it.each(compiledCases)(
    "runs the compiled entry under $engine without a TypeScript loader",
    ({ engine, expected }) => {
      const spec = childSpawnSpec(engine, compiledTarget);

      expect(spec).toStrictEqual(expected);
    },
  );
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
 *
 * @param alias - The benchmark name.
 * @param overrides - Fields replacing the defaults.
 * @returns A BenchEntry shaped like one mitata json entry.
 */
function benchEntry(alias: string, overrides: Partial<BenchEntry> = {}): BenchEntry {
  return {
    alias,
    runs: [{ stats: { p50: 1234.5, heap: { avg: 64 } }, args: { size: 1000 }, error: null }],
    kind: "iter",
    ...overrides,
  };
}

/** A valid single-entry BenchReport for BENCH, with any field replaceable through `overrides`. */
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

describe("namespaceReport", () => {
  it("prefixes every benchmark alias with engine/", () => {
    const input = report({
      benchmarks: [benchEntry("access.get_1field"), benchEntry("entity.spawn")],
    });

    const namespaced = namespaceReport(input, "bun");

    expect(namespaced.benchmarks.map((e) => e.alias)).toStrictEqual([
      "bun/access.get_1field",
      "bun/entity.spawn",
    ]);
  });

  it("inserts an optimized/ segment after the engine prefix for an optimized run", () => {
    const input = report({
      benchmarks: [benchEntry("access.get_1field"), benchEntry("entity.spawn")],
    });

    const namespaced = namespaceReport(input, "bun", { optimized: true });

    expect(namespaced.benchmarks.map((e) => e.alias)).toStrictEqual([
      "bun/optimized/access.get_1field",
      "bun/optimized/entity.spawn",
    ]);
  });

  it("preserves runs, layout, and context unchanged", () => {
    const customRuns = [
      { stats: { p50: 9999, heap: { avg: 128 } }, args: { size: 500 }, error: null },
    ];
    const input = report({
      benchmarks: [benchEntry("access.get_1field", { runs: customRuns })],
    });

    const namespaced = namespaceReport(input, "node");

    const entry = namespaced.benchmarks[0];
    expect(entry?.runs).toStrictEqual(customRuns);
    expect(entry?.["kind"]).toBe("iter");
    expect(namespaced.layout).toStrictEqual(LAYOUT);
    expect(namespaced.context).toStrictEqual(CONTEXT);
  });

  it("does not mutate the input report", () => {
    const input = report({ benchmarks: [benchEntry("access.get_1field")] });
    const originalAlias = input.benchmarks[0]?.alias;

    namespaceReport(input, "bun");

    expect(input.benchmarks[0]?.alias).toBe(originalAlias);
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

    it("takes layout and context from the first report", () => {
      const merged = mergeReports([first, second, third]);

      expect({ layout: merged.layout, context: merged.context }).toStrictEqual({
        layout: LAYOUT,
        context: CONTEXT,
      });
    });

    it("concatenates entries in input order and carries each entry's nested run stats through unchanged", () => {
      const merged = mergeReports([first, second, third]);

      expect(merged.benchmarks).toStrictEqual([
        benchEntry("access.get_1field"),
        benchEntry("entity.spawn"),
        benchEntry("iteration.each_soa"),
      ]);
    });
  });

  describe("when merging namespaced reports from different engines", () => {
    it("merges cleanly because the aliases differ", () => {
      const nodeReport = report({ benchmarks: [benchEntry("node/access.get_1field")] });
      const bunReport = report({ benchmarks: [benchEntry("bun/access.get_1field")] });

      const merged = mergeReports([nodeReport, bunReport]);

      expect(merged.benchmarks.map((e) => e.alias)).toStrictEqual([
        "node/access.get_1field",
        "bun/access.get_1field",
      ]);
    });
  });

  describe("when merging a plain and an optimized report from the same engine", () => {
    it("keeps both entries because the optimized/ segment tells them apart", () => {
      const measured = report({ benchmarks: [benchEntry("access.get_1field")] });
      const plain = namespaceReport(measured, "node");
      const optimized = namespaceReport(measured, "node", { optimized: true });

      const merged = mergeReports([plain, optimized]);

      expect(merged.benchmarks.map((e) => e.alias)).toStrictEqual([
        "node/access.get_1field",
        "node/optimized/access.get_1field",
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

describe("compileOptimized", () => {
  describe("when an output cannot be written", () => {
    let session: Session;

    beforeAll(async () => {
      session = await openSession(BENCHMARK_CONFIG);
    }, COMPILE_TIMEOUT_MS);

    afterAll(async () => {
      await session.close();
      removeTempDirs();
    });

    it(
      "rejects with CompileError naming the output directory",
      async () => {
        const outDir = join(createProject({ taken: "" }), "taken");

        const compiled = compileOptimized(session, outDir);

        await expect(compiled).rejects.toThrow(CompileError);
        await expect(compiled).rejects.toThrow(outDir);
      },
      COMPILE_TIMEOUT_MS,
    );
  });

  describe.each(COMPILE_FAILURES)("on a source with $label", ({ source, diagnostic }) => {
    let session: Session;

    beforeAll(async () => {
      session = await openSession(benchmarkConfigProject(source));
    }, COMPILE_TIMEOUT_MS);

    afterAll(async () => {
      await session.close();
      removeBenchmarkProjects();
      removeTempDirs();
    });

    it(
      "rejects with CompileError carrying the diagnostic",
      async () => {
        const compiled = compileOptimized(session, createProject({}));

        await expect(compiled).rejects.toThrow(CompileError);
        await expect(compiled).rejects.toThrow(diagnostic);
      },
      COMPILE_TIMEOUT_MS,
    );
  });
});
