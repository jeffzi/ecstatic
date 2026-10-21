import { describe, expect, it } from "vitest";

import {
  CONVERGENT_FIXTURES,
  fixturePath,
  GOLDEN_FILE,
  INPUT_FILE,
  loadFixtureExport,
} from "./fixture-corpus.js";

/**
 * Each case loads two module graphs against a fresh registry; the first case in a worker also pays
 * the cold transform of the runtime sources, which in a full parallel run can exceed the 5 s default.
 */
const CASE_TIMEOUT_MS = 30_000;

/** Imports `file` against a fresh module registry and returns the trace its `scenario()` builds. */
async function runScenario(file: string): Promise<unknown> {
  const scenario = await loadFixtureExport(file, "scenario");
  return scenario();
}

describe("fixture traces", () => {
  it("finds fixtures", () => {
    expect(CONVERGENT_FIXTURES).not.toHaveLength(0);
  });

  it.each(CONVERGENT_FIXTURES)(
    "%s: the golden's trace equals the input's",
    async (fixture) => {
      const inputTrace = await runScenario(fixturePath(fixture, INPUT_FILE));

      const goldenTrace = await runScenario(fixturePath(fixture, GOLDEN_FILE));

      expect(goldenTrace).toStrictEqual(inputTrace);
    },
    CASE_TIMEOUT_MS,
  );
});
