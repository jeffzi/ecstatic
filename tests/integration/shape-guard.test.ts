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

/** The shape the spawn fixture's iterated storage has, as the guard keys it. */
const SPOT_KEY = "c9:LyingSpot{1:x=n}|";

/** The shape the spawn fixture's casts to another component claim, as the guard keys it. */
const OTHER_KEY = "c10:LyingOther{1:y=n}|";

/** The shape the spawn fixture's casts to a same-named component with another field claim, as the guard keys it. */
const TWIN_KEY = "c9:LyingSpot{1:z=n}|";

/** What a walk of the spawn fixture left, as its `Outcome` reports it. */
interface Outcome {
  readonly error: string | undefined;
  readonly xs: number[];
  readonly rows: number;
  readonly others: number;
}

/** Imports the spawn fixture's golden against a fresh module registry and runs its walk `name`. */
async function runCompiledWalk(name: string): Promise<unknown> {
  const walk = await loadFixtureExport(
    fixturePath("divergent/lying-spawn-target", GOLDEN_FILE),
    name,
  );
  return walk();
}

describe("an each call compiled hoisted whose body spawns through a cast that lies about the iterated storage", () => {
  describe.runIf(DEBUG)("with DEBUG on", () => {
    it.each<{ walk: string; claimed: string; others: number }>([
      { walk: "spawnThroughLie", claimed: OTHER_KEY, others: 0 },
      { walk: "spawnManyThroughLie", claimed: OTHER_KEY, others: 0 },
      { walk: "spawnAfterTruth", claimed: OTHER_KEY, others: 1 },
      { walk: "spawnManyAfterTruth", claimed: OTHER_KEY, others: 2 },
      { walk: "spawnThroughTwin", claimed: TWIN_KEY, others: 0 },
      { walk: "spawnManyThroughTwin", claimed: TWIN_KEY, others: 0 },
    ])(
      "$walk throws the shape guard's error at the lying spawn, before it adds a row or any later write",
      async ({ walk, claimed, others }) => {
        const outcome = await runCompiledWalk(walk);

        expect(outcome).toStrictEqual({
          error: `ecstatic: shape guard expected ${claimed}, got ${SPOT_KEY}`,
          xs: [1, 102],
          rows: 2,
          others,
        } satisfies Outcome);
      },
    );

    it.each(["spawnThroughLieOnLaterRow", "spawnManyThroughLieOnLaterRow"])(
      "%s throws at the lying spawn on the second row visited, the first row's writes kept",
      async (walk) => {
        const outcome = await runCompiledWalk(walk);

        expect(outcome).toStrictEqual({
          error: `ecstatic: shape guard expected ${OTHER_KEY}, got ${SPOT_KEY}`,
          xs: [101, 1102],
          rows: 2,
          others: 0,
        } satisfies Outcome);
      },
    );
  });

  describe.runIf(!DEBUG)("with NDEBUG set", () => {
    it.each<{ walk: string; rows: number; others: number }>([
      { walk: "spawnThroughLie", rows: 4, others: 0 },
      { walk: "spawnManyThroughLie", rows: 4, others: 0 },
      { walk: "spawnThroughLieOnLaterRow", rows: 3, others: 0 },
      { walk: "spawnManyThroughLieOnLaterRow", rows: 3, others: 0 },
      { walk: "spawnAfterTruth", rows: 4, others: 2 },
      { walk: "spawnManyAfterTruth", rows: 4, others: 4 },
      { walk: "spawnThroughTwin", rows: 4, others: 0 },
      { walk: "spawnManyThroughTwin", rows: 4, others: 0 },
    ])(
      "$walk spawns every row it reaches without throwing, the spawn guard stripped",
      async ({ walk, rows, others }) => {
        const outcome = await runCompiledWalk(walk);

        expect(outcome).toMatchObject({ error: undefined, rows, others });
      },
    );
  });
});
