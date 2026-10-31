import { beforeEach, describe, expect, it, vi } from "vitest";

/** What the registry holds after a load: how many benchmarks, and under which groups. */
interface Registered {
  count: number;
  groups: Set<string>;
}

/** How many benchmarks the registry holds, and the set of groups they are named under. */
async function registered(): Promise<Registered> {
  const { benchNames } = await import("../../benchmarks/runner.js");
  const names = benchNames();
  return { count: names.length, groups: new Set(names.map((name) => name.split("/")[0] ?? "")) };
}

// The registry is module state shared by every importer in one module graph, so each case starts
// a fresh graph and imports the loader and the runner after it.
beforeEach(() => {
  vi.resetModules();
});

describe("loadSuite", () => {
  describe.each([
    { group: "access", count: 5, importSuite: () => import("../../benchmarks/access-bench.js") },
    { group: "entity", count: 6, importSuite: () => import("../../benchmarks/entity-bench.js") },
    {
      group: "iteration",
      count: 11,
      importSuite: () => import("../../benchmarks/iteration-bench.js"),
    },
    { group: "many", count: 7, importSuite: () => import("../../benchmarks/many-bench.js") },
  ])("for a benchmark of the $group suite", ({ group, count, importSuite }) => {
    it(`registers only the ${String(count)} benchmarks of the ${group} suite`, async () => {
      const { loadSuite } = await import("../../benchmarks/suite-loader.js");

      await loadSuite(`${group}/banana`);

      expect(await registered()).toStrictEqual({ count, groups: new Set([group]) });
    });

    it(`gives back the ${group} suite's sink reader`, async () => {
      const { loadSuite } = await import("../../benchmarks/suite-loader.js");

      const reader = await loadSuite(`${group}/banana`);

      const suite = await importSuite();
      expect(reader).toBe(suite.sinkValue);
    });
  });

  describe("for a benchmark of the reference suite", () => {
    it("registers only the 2 benchmarks of the reference suite", async () => {
      const { loadSuite } = await import("../../benchmarks/suite-loader.js");

      await loadSuite("reference/banana");

      expect(await registered()).toStrictEqual({ count: 2, groups: new Set(["reference"]) });
    });

    it("gives back a sink reader that reads 0, since the suite has no sink", async () => {
      const { loadSuite } = await import("../../benchmarks/suite-loader.js");

      const reader = await loadSuite("reference/banana");

      expect(reader()).toBe(0);
    });
  });

  describe.each([
    { label: "a group no suite has", name: "banana/throws" },
    { label: "a group named after an Object.prototype member", name: "constructor/x" },
    { label: "no group, though the whole name is a suite's group", name: "access" },
  ])("for a name with $label", ({ name }) => {
    it("registers no benchmark", async () => {
      const { loadSuite } = await import("../../benchmarks/suite-loader.js");

      await loadSuite(name);

      expect(await registered()).toStrictEqual({ count: 0, groups: new Set() });
    });

    it("gives back a sink reader that reads 0", async () => {
      const { loadSuite } = await import("../../benchmarks/suite-loader.js");

      const reader = await loadSuite(name);

      expect(reader()).toBe(0);
    });
  });
});

describe("loadAllSuites", () => {
  it("registers all 31 benchmarks of the five suites", async () => {
    const { loadAllSuites } = await import("../../benchmarks/suite-loader.js");

    await loadAllSuites();

    expect(await registered()).toStrictEqual({
      count: 31,
      groups: new Set(["access", "entity", "iteration", "many", "reference"]),
    });
  });
});
