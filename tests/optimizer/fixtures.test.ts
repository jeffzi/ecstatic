import { readdirSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { assert, describe, expect, it, vi } from "vitest";

const FIXTURES_DIR = fileURLToPath(new URL("fixtures", import.meta.url));
const INPUT_FILE = "input.ts";

/**
 * The category whose golden files diverge from their inputs by design: a cast lies about the storage's shape, so the
 * guard throws where the runtime does not. `shape-guard.test.ts` covers it.
 */
const DIVERGENT = "divergent/";

/** Every fixture directory under `fixtures/` but the divergent ones, as `category/case`, found by its `input.ts`. */
const FIXTURES = readdirSync(FIXTURES_DIR, { recursive: true, encoding: "utf8" })
  .filter((path) => path.endsWith(`${sep}${INPUT_FILE}`))
  .map((path) => dirname(path).split(sep).join("/"))
  .filter((fixture) => !fixture.startsWith(DIVERGENT))
  .toSorted();

/**
 * Each case loads two module graphs against a fresh registry; the first case in a worker also pays
 * the cold transform of the runtime sources, which in a full parallel run can exceed the 5 s default.
 */
const CASE_TIMEOUT_MS = 30_000;

/** Imports `file` against a fresh module registry and returns the trace its `scenario()` builds. */
async function runScenario(file: string): Promise<unknown> {
  vi.resetModules();
  const module: unknown = await import(file);
  assert(typeof module === "object" && module !== null && "scenario" in module);
  const { scenario } = module;
  assert(typeof scenario === "function", `${file} does not export a scenario function`);
  return scenario();
}

describe("fixture corpus", () => {
  it("finds fixtures", () => {
    expect(FIXTURES).not.toHaveLength(0);
  });

  it.each(FIXTURES)(
    "%s: the golden's trace equals the input's",
    async (fixture) => {
      const dir = join(FIXTURES_DIR, fixture);
      const inputTrace = await runScenario(join(dir, INPUT_FILE));

      const goldenTrace = await runScenario(join(dir, "expected.ts.golden"));

      expect(goldenTrace).toStrictEqual(inputTrace);
    },
    CASE_TIMEOUT_MS,
  );
});
