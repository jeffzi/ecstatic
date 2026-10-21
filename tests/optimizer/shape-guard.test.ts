import { describe, expect, it } from "vitest";

import { DEBUG } from "../../src/ecstatic/index.js";
import { fixturePath, GOLDEN_FILE, loadFixtureExport } from "./fixture-corpus.js";

/** The shape the fixture's cast claims, as the guard keys it. */
const CLAIMED_KEY = "c16:DivergentClaimed{1:b=n}|";

/** The shape the fixture's storage has, as the guard keys it. */
const ACTUAL_KEY = "c13:DivergentReal{1:a=n}|";

type Visit = (rows: number, visited: number[]) => void;

/** Imports the fixture's golden against a fresh module registry and returns its `visit` function. */
async function loadCompiledVisit(): Promise<Visit> {
  const visit = await loadFixtureExport(fixturePath("divergent/lying-cast", GOLDEN_FILE), "visit");
  return (rows, visited) => {
    visit(rows, visited);
  };
}

describe("an each call compiled against a shape a cast lies about", () => {
  describe.runIf(DEBUG)("with DEBUG on", () => {
    it.each([0, 2])("throws the shape guard's error before any of %i rows runs", async (rows) => {
      const visit = await loadCompiledVisit();
      const visited: number[] = [];

      expect(() => {
        visit(rows, visited);
      }).toThrow(`ecstatic: shape guard expected ${CLAIMED_KEY}, got ${ACTUAL_KEY}`);
      expect(visited).toStrictEqual([]);
    });
  });

  describe.runIf(!DEBUG)("with NDEBUG set", () => {
    it("returns on an empty storage, the shape guard stripped", async () => {
      const visit = await loadCompiledVisit();
      const visited: number[] = [];

      visit(0, visited);

      expect(visited).toStrictEqual([]);
    });
  });
});
