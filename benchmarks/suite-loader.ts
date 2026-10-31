/**
 * Loads benchmark suites on demand.
 *
 * Importing a suite module registers its benchmarks as a side effect. A benchmark child loads only
 * the suite its benchmark belongs to: under Bun, module code loaded in the same process slows the
 * measured benchmark's timed calls even when none of it runs, and the other suites' code is part of
 * that. Every suite registers its benchmarks under its own group, the part of the name before the
 * `/`.
 */

/**
 * Read the sink of a suite that has none.
 *
 * @returns Always 0.
 */
const NO_SINK = (): number => 0;

/**
 * Each suite's group, mapped to a load of its module that gives back its sink reader.
 *
 * The import specifiers are fixed here, never built from a benchmark name, so a name can only ever
 * pick one of these modules; a `Map` keeps a group such as `constructor` from matching an
 * `Object.prototype` member. Insertion order is the order every suite registers in.
 */
const SUITES: ReadonlyMap<string, () => Promise<() => number>> = new Map([
  ["access", async () => (await import("./access-bench.js")).sinkValue],
  ["entity", async () => (await import("./entity-bench.js")).sinkValue],
  ["iteration", async () => (await import("./iteration-bench.js")).sinkValue],
  ["many", async () => (await import("./many-bench.js")).sinkValue],
  [
    "reference",
    async () => {
      // The reference suite accumulates nothing, so it is imported for registration alone.
      await import("./reference-bench.js");
      return NO_SINK;
    },
  ],
]);

/**
 * Load the one suite a benchmark belongs to, registering that suite's benchmarks and no other's.
 *
 * @param benchName - Benchmark name, `<group>/<name>`; its group picks the suite.
 * @returns The suite's sink reader, which reads what the suite's read-only bodies have added so far.
 * The reader always reads 0 when the suite has no sink, or when the name has no `/` or its group
 * names no suite; in those last two cases no suite is loaded.
 * @throws Error (as a rejection) whatever the suite module throws while it loads.
 */
export async function loadSuite(benchName: string): Promise<() => number> {
  const slash = benchName.indexOf("/");
  const load = slash === -1 ? undefined : SUITES.get(benchName.slice(0, slash));
  return load === undefined ? NO_SINK : await load();
}

/**
 * Load every suite, one after another, so the registry holds every benchmark in suite order.
 *
 * @returns Once every suite has registered its benchmarks.
 * @throws Error (as a rejection) whatever the first suite module that fails to load throws.
 */
export async function loadAllSuites(): Promise<void> {
  for (const load of SUITES.values()) {
    await load();
  }
}
