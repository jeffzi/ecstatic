import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { assert, describe, expect, it, vi } from "vitest";

import { DEBUG } from "../../src/index.js";

const FIXTURE_DIR = fileURLToPath(new URL("fixtures/divergent/lying-cast", import.meta.url));

/** The shape the fixture's cast claims, as the guard keys it. */
const CLAIMED_KEY = "c16:DivergentClaimed{1:b=n}|";

/** The shape the fixture's storage has, as the guard keys it. */
const ACTUAL_KEY = "c13:DivergentReal{1:a=n}|";

type Visit = (rows: number, visited: number[]) => void;

/** Imports the fixture's `file` against a fresh module registry and returns the `visit` function it exports. */
async function loadVisit(file: string): Promise<Visit> {
  vi.resetModules();
  const module: unknown = await import(join(FIXTURE_DIR, file));
  assert(typeof module === "object" && module !== null && "visit" in module);
  const { visit } = module;
  assert(typeof visit === "function", `${file} does not export a visit function`);
  return (rows, visited) => {
    visit(rows, visited);
  };
}

describe("an each call compiled against a shape a cast lies about", () => {
  describe.runIf(DEBUG)("with DEBUG on", () => {
    it.each([0, 2])("throws the shape guard's error before any of %i rows runs", async (rows) => {
      const visit = await loadVisit("expected.ts.golden");
      const visited: number[] = [];

      expect(() => {
        visit(rows, visited);
      }).toThrow(`ecstatic: shape guard expected ${CLAIMED_KEY}, got ${ACTUAL_KEY}`);
      expect(visited).toStrictEqual([]);
    });
  });

  describe.runIf(!DEBUG)("with NDEBUG set", () => {
    it("returns on an empty storage as the runtime's call does", async () => {
      const runtime = await loadVisit("input.ts");
      const runtimeVisited: number[] = [];
      runtime(0, runtimeVisited);
      const compiled = await loadVisit("expected.ts.golden");
      const compiledVisited: number[] = [];

      compiled(0, compiledVisited);

      expect(compiledVisited).toStrictEqual(runtimeVisited);
    });
  });
});
