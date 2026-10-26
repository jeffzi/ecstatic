import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { shapeKey } from "../../../../src/plugin/optimizer/facts.js";
import type { Mode } from "../../../../src/plugin/optimizer/plan.js";
import { declarationCounts, ROW_LOOP } from "../printed.js";
import { closeProject, projectPath, SPAWN_TIMEOUT_MS, writeProject } from "../project.js";
import {
  CASE_PRELUDE,
  EmitProject,
  everyMode,
  everyRun,
  filterOutcome,
  MODE_SOURCE,
  MODES,
  type PlannedCase,
  RUN_TIMEOUT_MS,
  rewriteAt,
  writeCycle,
} from "./emit-project.js";

/** The shape guard of a loop, capturing the shape key it checks the storage against. */
const SHAPE_GUARD = /assertShape\(\w+, "([^"]*)"\)/gu;

/** A shape guard on a line of its own, gated by the project runtime's `DEBUG` initializer. */
const RUNTIME_GATED_GUARD =
  /^\(typeof NDEBUG === "undefined" \|\| !NDEBUG\) && ecstatic_internal\.assertShape\(\w+, "[^"]*"\);$/u;

/** A shape guard on a line of its own, gated by the `DEBUG` initializer of the alternate runtime root. */
const ROOT_GATED_GUARD = /^\(typeof NDEBUG !== "string"\) && ecstatic_internal\.assertShape\(/u;

let project: EmitProject;

beforeAll(async () => {
  project = await EmitProject.open();
}, SPAWN_TIMEOUT_MS);

afterAll(() => closeProject(project.session));

/**
 * Splits emitted file text at its row loop openers.
 *
 * @param text - The text of an emitted file.
 * @returns The text before the first row loop opener (`before`), the pieces after each opener
 *   (`loops`), and those pieces rejoined with the opener (`inside`).
 */
function splitAtLoops(text: string): { before: string; loops: string[]; inside: string } {
  const [before = "", ...loops] = text.split(ROW_LOOP);
  return { before, loops, inside: loops.join(ROW_LOOP) };
}

/** The shape key each shape guard in `text` checks its storage against, in order. */
function guards(text: string): string[] {
  return [...text.matchAll(SHAPE_GUARD)].map(([, key = ""]) => key);
}

/** The lines of `text` that read `NDEBUG`, trimmed. */
function ndebugLines(text: string): string[] {
  return text
    .split("\n")
    .filter((line) => line.includes("NDEBUG"))
    .map((line) => line.trim());
}

/**
 * The module the circular-import case enters by: its `total` sums an inlined loop over a fresh
 * storage, and its `scenario` returns the sum its partner took while this module had not yet run.
 */
const CYCLE_ENTRY_SOURCE = `import { createWorld, each, register, spawn } from "../src/ecstatic/index.js";
import { Mover } from "../app/schema.js";
import { early } from "./partner.js";

export function total(): number {
    const movers = register(createWorld(), Mover);
    spawn(movers, { Position: { x: 2, y: 0 }, Velocity: { dx: 0, dy: 0 } });
    spawn(movers, { Position: { x: 3, y: 0 }, Velocity: { dx: 0, dy: 0 } });
    let sum = 0;
    each(movers, (e) => {
        sum += e.Position.x;
    });
    return sum;
}

export function scenario(): unknown {
    return early;
}
`;

/**
 * The entry module of a cycle whose `total` sums the rows of a Guarded storage that an inlined loop
 * visits for the filter `{ all: [Shield] }`, written in the loop's call or held in a binding.
 *
 * @param bound - Whether the filter is held in a binding, which is resolved at runtime.
 * @returns The entry module's text.
 */
function cycleGuardedSource(bound: boolean): string {
  const imports = bound ? "each, type EachFilter" : "each";
  const binding = bound ? "    const filter: EachFilter = { all: [Shield] };\n" : "";
  const filter = bound ? "filter" : "{ all: [Shield] }";
  return `import { ${imports} } from "../src/ecstatic/index.js";
import { Shield, guarded } from "../app/schema.js";
import { early } from "./partner.js";

export function total(): number {
    const { storage } = guarded();
${binding}    let sum = 0;
    each(storage, ${filter}, (e) => {
        sum += e.Position.x;
    });
    return sum;
}

export function scenario(): unknown {
    return early;
}
`;
}

/**
 * The entry module of a cycle whose `total` sums, over a Guarded storage, the rows an inlined loop's
 * literal filter folds to a matcher for.
 */
const CYCLE_MASKED_ENTRY_SOURCE = cycleGuardedSource(false);

/**
 * The entry module of a cycle whose `total` runs `call`, a spawn into a Statue storage, in an inlined
 * loop over a Mover storage of two rows, and sums their Position.x with the Statue rows.
 */
function cycleSpawnSource(call: string): string {
  return `import { createWorld, each, register, spawn, spawnMany } from "../src/ecstatic/index.js";
import { Mover, Statue } from "../app/schema.js";
import { early } from "./partner.js";

export function total(): number {
    const movers = register(createWorld(), Mover);
    const statues = register(createWorld(), Statue);
    spawn(movers, { Position: { x: 2, y: 0 }, Velocity: { dx: 0, dy: 0 } });
    spawn(movers, { Position: { x: 3, y: 0 }, Velocity: { dx: 0, dy: 0 } });
    let sum = 0;
    each(movers, (e) => {
        ${call};
        sum += e.Position.x;
    });
    return sum + statues.n;
}

export function scenario(): unknown {
    return early;
}
`;
}

/**
 * The entry module of a cycle whose `total` sums, over a Guarded storage, the rows an inlined loop
 * visits for a filter held in a binding, which is resolved at runtime.
 */
const CYCLE_RUNTIME_FILTER_ENTRY_SOURCE = cycleGuardedSource(true);

/** The module path, relative to `app/`, of `planned`'s case file as written, which runs on the runtime. */
function runtimeModule(planned: { readonly rel: string }): string {
  return `./${planned.rel.slice("app/".length, -".ts".length)}.js`;
}

/**
 * Plans and emits the cycle whose entry module is `entry`, writes it and its emitted rewrite as the
 * project directories `${dir}-runtime` and `${dir}-rewritten`, and runs both with the checks on and
 * stripped.
 *
 * @param dir - The prefix of the two directories' names.
 * @param entry - The entry module's text.
 * @returns The planned case, the emitted text, and each setting's result keyed by `runtime` and
 *   `rewritten`.
 */
async function runCycle(
  dir: string,
  entry: string,
): Promise<{ planned: PlannedCase; text: string; checked: unknown; stripped: unknown }> {
  const planned = await project.planned(entry);
  const { text } = await project.emit(planned);
  const modules = {
    runtime: writeCycle(project.root, `${dir}-runtime`, entry),
    rewritten: writeCycle(project.root, `${dir}-rewritten`, text),
  };
  return { planned, text, ...(await project.runSettings(modules)) };
}

/** Two `each` calls over Mover storages and one over a Statue storage, in a strict-mode file. */
const PREAMBLE_SOURCE = `"use strict";
import { createWorld, each, register } from "../src/ecstatic/index.js";
import { Mover, Statue } from "./schema.js";
const movers = register(createWorld(), Mover);
const statues = register(createWorld(), Statue);
const others = register(createWorld(), Mover);
each(movers, (e) => {
    e.Position.x = 1;
});
each(statues, (e) => {
    e.Position.x = 2;
});
each(others, (e) => {
    e.Position.x = 3;
});
`;

describe("EmitFile", () => {
  describe("inline", () => {
    it.each([
      {
        name: "rows run from the last to the first, reading and writing fields and id",
        source: `export function scenario(): unknown {
    const movers = register(createWorld(), Mover);
    const ids = [
        spawn(movers, { Position: { x: 1, y: 0 }, Velocity: { dx: 2, dy: 0 } }),
        spawn(movers, { Position: { x: 5, y: 0 }, Velocity: { dx: -1, dy: 0 } }),
        spawn(movers, { Position: { x: 10, y: 0 }, Velocity: { dx: 3, dy: 0 } }),
    ];
    const order: number[] = [];
    each(movers, (e) => {
        order.push(ids.indexOf(e.id));
        e.Position.x = e.Position.x + e.Velocity.dx;
    });
    return { order, xs: ids.map((id) => get(movers, id, Position.x)) };
}
`,
        expected: { order: [2, 1, 0], xs: [3, 4, 13] },
      },
      {
        name: "a plain-array field is read and written like a numeric one",
        source: `export function scenario(): unknown {
    const statues = register(createWorld(), Statue);
    const ids = [
        spawn(statues, { Position: { x: 1, y: 0 }, Label: { text: "a" } }),
        spawn(statues, { Position: { x: 2, y: 0 }, Label: { text: "b" } }),
    ];
    each(statues, (e) => {
        e.Label.text = e.Label.text + e.Position.x;
    });
    return ids.map((id) => get(statues, id, Label.text));
}
`,
        expected: ["a1", "b2"],
      },
      {
        name: "the storage argument is evaluated once, before any row, even when the body reassigns it",
        source: `export function scenario(): unknown {
    const a = register(createWorld(), Mover);
    const b = register(createWorld(), Mover);
    spawn(a, { Position: { x: 0, y: 0 }, Velocity: { dx: 0, dy: 0 } });
    spawn(a, { Position: { x: 0, y: 0 }, Velocity: { dx: 0, dy: 0 } });
    spawn(b, { Position: { x: 0, y: 0 }, Velocity: { dx: 0, dy: 0 } });
    spawn(b, { Position: { x: 0, y: 0 }, Velocity: { dx: 0, dy: 0 } });
    spawn(b, { Position: { x: 0, y: 0 }, Velocity: { dx: 0, dy: 0 } });
    let current = a;
    let rows = 0;
    each(current, () => {
        current = b;
        rows += 1;
    });
    let calls = 0;
    const pick = (): typeof a => {
        calls += 1;
        return a;
    };
    each(pick(), () => {
        calls += 10;
    });
    return { rows, calls };
}
`,
        expected: { rows: 2, calls: 21 },
      },
      {
        name: "an empty storage runs no row",
        source: `export function scenario(): unknown {
    const movers = register(createWorld(), Mover);
    let rows = 0;
    each(movers, (e) => {
        rows += 1;
        e.Position.x = 1;
    });
    return { rows };
}
`,
        expected: { rows: 0 },
      },
      {
        name: "a throw from the body leaves the loop",
        source: `export function scenario(): unknown {
    const movers = register(createWorld(), Mover);
    spawn(movers, { Position: { x: 0, y: 0 }, Velocity: { dx: 0, dy: 0 } });
    spawn(movers, { Position: { x: 0, y: 0 }, Velocity: { dx: 0, dy: 0 } });
    spawn(movers, { Position: { x: 0, y: 0 }, Velocity: { dx: 0, dy: 0 } });
    let rows = 0;
    try {
        each(movers, () => {
            rows += 1;
            if (rows === 2) {
                throw new RangeError("stop");
            }
        });
    } catch (error) {
        return { rows, thrown: error instanceof RangeError };
    }
    return { rows, thrown: false };
}
`,
        expected: { rows: 2, thrown: true },
      },
      {
        name: "rows the body spawns are not visited",
        source: `export function scenario(): unknown {
    const movers = register(createWorld(), Mover);
    spawn(movers, { Position: { x: 0, y: 0 }, Velocity: { dx: 0, dy: 0 } });
    spawn(movers, { Position: { x: 0, y: 0 }, Velocity: { dx: 0, dy: 0 } });
    let rows = 0;
    each(movers, () => {
        rows += 1;
        spawnMany(movers, 20);
    });
    return { rows };
}
`,
        expected: { rows: 2 },
      },
      {
        name: "generated names never shadow a name the body reads",
        source: `export function scenario(): unknown {
    const movers = register(createWorld(), Mover);
    const ids = [spawn(movers, { Position: { x: 1, y: 0 }, Velocity: { dx: 2, dy: 0 } })];
    const storage = "storage", n = 10, i = 20, entities = 30, x = 40, dx = 50;
    const seen: unknown[] = [];
    each(movers, (e) => {
        e.Position.x = e.Velocity.dx + n + i + entities + x + dx;
        seen.push(storage, get(movers, e.id, Position.x), get(movers, e.id, Velocity.dx));
    });
    return { seen, xs: ids.map((id) => get(movers, id, Position.x)) };
}
`,
        expected: { seen: ["storage", 152, 2], xs: [152] },
      },
      {
        name: "two loops in one function over components sharing a field name keep every column apart",
        source: `export function scenario(): unknown {
    const sized = register(createWorld(), Sized);
    const ids = [
        spawn(sized, { Position: { x: 1, y: 0 }, Scale: { x: 10, y: 0 } }),
        spawn(sized, { Position: { x: 2, y: 0 }, Scale: { x: 20, y: 0 } }),
    ];
    const i = 100, x = 1000;
    each(sized, (e) => {
        e.Position.x = e.Position.x + e.Scale.x + i;
    });
    each(sized, (e) => {
        e.Scale.x = e.Scale.x + e.Position.x + x;
    });
    return ids.map((id) => [get(sized, id, Position.x), get(sized, id, Scale.x)]);
}
`,
        expected: [
          [111, 1121],
          [122, 1142],
        ],
      },
      {
        name: "a call that is the expression body of an arrow function runs on every call of the arrow",
        source: `export function scenario(): unknown {
    const movers = register(createWorld(), Mover);
    spawn(movers, { Position: { x: 1, y: 0 }, Velocity: { dx: 0, dy: 0 } });
    spawn(movers, { Position: { x: 2, y: 0 }, Velocity: { dx: 0, dy: 0 } });
    const seen: unknown[] = [];
    const run = (): void => each(movers, (e) => {
        seen.push(e.Position.x);
    });
    seen.push(typeof run());
    run();
    return seen;
}
`,
        expected: [2, 1, "undefined", 2, 1],
      },
      {
        name: "a destructuring var is a fresh binding on every row, unset before its declaration",
        source: `export function scenario(): unknown {
    const movers = register(createWorld(), Mover);
    spawn(movers, { Position: { x: 1, y: 0 }, Velocity: { dx: 0, dy: 0 } });
    spawn(movers, { Position: { x: 2, y: 0 }, Velocity: { dx: 0, dy: 0 } });
    const seen: unknown[] = [];
    each(movers, (e) => {
        seen.push(typeof first, typeof second);
        var [first, { second }] = [e.Position.x, { second: e.Position.x * 10 }];
        seen.push(first + second);
    });
    return seen;
}
`,
        expected: ["undefined", "undefined", 22, "undefined", "undefined", 11],
      },
      {
        name: "an indented call keeps the text of the multi-line literals in its body",
        source: [
          "export function scenario(): unknown {",
          "    const movers = register(createWorld(), Mover);",
          "    spawn(movers, { Position: { x: 1, y: 0 }, Velocity: { dx: 0, dy: 0 } });",
          "    const seen: string[] = [];",
          "    if (movers.n > 0) {",
          "        each(movers, (e) => {",
          "            seen.push(`x ${e.Position.x}",
          "  indented \"${'a\\",
          "b'}\" ${`",
          "`}",
          "end`);",
          "        });",
          "    }",
          "    return seen;",
          "}",
          "",
        ].join("\n"),
        expected: ['x 1\n  indented "ab" \n\nend'],
      },
    ])(
      "runs the body as the runtime call does when $name",
      async ({ source, expected }) => {
        const results = await project.runEveryMode(source);

        expect(results).toStrictEqual(everyMode(expected));
      },
      RUN_TIMEOUT_MS,
    );

    it.each([
      {
        name: "a class expression",
        body: `class {
        static {
            seen.push(e.Position.x);
        }
    }`,
        expected: [2, 1],
      },
      {
        name: "a parenthesized object literal",
        body: "({ x: e.Position.x * 10 }).x + seen.push(e.Position.x * 10)",
        expected: [20, 10],
      },
      {
        name: "a function expression",
        body: `function (x: number) {
        seen.push(x * 100);
    }.call(undefined, e.Position.x)`,
        expected: [200, 100],
      },
    ])(
      "runs an expression body that starts with $name as the runtime call does, with checks on and stripped",
      async ({ body, expected }) => {
        const source = `export function scenario(): unknown {
    const movers = register(createWorld(), Mover);
    spawn(movers, { Position: { x: 1, y: 0 }, Velocity: { dx: 0, dy: 0 } });
    spawn(movers, { Position: { x: 2, y: 0 }, Velocity: { dx: 0, dy: 0 } });
    const seen: unknown[] = [];
    each(movers, (e) => ${body});
    return seen;
}
`;

        const results = await project.runEverySetting(source);

        expect(results).toStrictEqual(everyRun(expected));
      },
      RUN_TIMEOUT_MS,
    );

    describe("when the body grows the storage", () => {
      const GROWTH_SOURCE = `export function scenario(): unknown {
    const movers = register(createWorld(), Mover);
    const ids = [
        spawn(movers, { Position: { x: 1, y: 0 }, Velocity: { dx: 0, dy: 0 } }),
        spawn(movers, { Position: { x: 2, y: 0 }, Velocity: { dx: 0, dy: 0 } }),
    ];
    each(movers, (e) => {
        if (e.Position.x === 2) {
            spawnMany(movers, 20);
        }
        e.Position.x = e.Position.x * 10;
    });
    return ids.map((id) => get(movers, id, Position.x));
}
`;

      it.each<{ name: string; mode: Mode; expected: number[] }>([
        {
          name: "realloc-safe mode writes the columns growth put in place",
          mode: "realloc-safe",
          expected: [10, 20],
        },
        {
          name: "hoisted mode writes the columns it read before the loop",
          mode: "hoisted",
          expected: [1, 2],
        },
      ])(
        "$name",
        async ({ mode, expected }) => {
          const planned = await project.planned(CASE_PRELUDE + GROWTH_SOURCE);
          const module = await project.emitModule(planned, mode, { mode });

          const results = await project.run({ rewritten: module });

          expect(results).toStrictEqual({ rewritten: expected });
        },
        RUN_TIMEOUT_MS,
      );
    });

    describe("when a circular import calls the loop before its module has run", () => {
      it.each([
        {
          name: "an unfiltered loop",
          dir: "cycle",
          entry: CYCLE_ENTRY_SOURCE,
          filter: undefined,
          expected: 5,
        },
        {
          name: "a loop whose literal filter folds to a matcher",
          dir: "cycle-masked",
          entry: CYCLE_MASKED_ENTRY_SOURCE,
          filter: "masked",
          expected: 1,
        },
        {
          name: "a loop whose filter is resolved at runtime",
          dir: "cycle-runtime-filter",
          entry: CYCLE_RUNTIME_FILTER_ENTRY_SOURCE,
          filter: "runtime",
          expected: 1,
        },
      ])(
        "runs $name as the runtime call does, with checks on and stripped",
        async ({ dir, entry, filter, expected }) => {
          const { planned, checked, stripped } = await runCycle(dir, entry);

          expect({
            filter: filterOutcome(rewriteAt(planned, 0)),
            checked,
            stripped,
          }).toStrictEqual({
            filter,
            checked: { runtime: expected, rewritten: expected },
            stripped: { runtime: expected, rewritten: expected },
          });
        },
        RUN_TIMEOUT_MS,
      );

      it.each([
        { op: "spawn", call: "spawn(statues)", expected: 7 },
        { op: "spawnMany", call: "spawnMany(statues, 2)", expected: 9 },
      ])(
        "runs a loop whose $op into another storage is guarded as the runtime call does, with checks on and stripped",
        async ({ op, call, expected }) => {
          const source = cycleSpawnSource(call);

          const { planned, text, checked, stripped } = await runCycle(`cycle-${op}`, source);

          expect({
            mode: rewriteAt(planned, 0).mode,
            spawnGuarded: /assertShape\(target(?:_\d+)?, /u.test(text),
            checked,
            stripped,
          }).toStrictEqual({
            mode: "hoisted",
            spawnGuarded: true,
            checked: { runtime: expected, rewritten: expected },
            stripped: { runtime: expected, rewritten: expected },
          });
        },
        RUN_TIMEOUT_MS,
      );
    });

    describe("when a loop compiled realloc-safe spawns through a cast that lies about the iterated storage", () => {
      /** A scenario whose loop over two Mover rows runs `body`, beside `helper`, then writes each row. */
      const lyingSource = (
        helper: string,
        body: string,
      ): string => `export function scenario(): unknown {
    const movers = register(createWorld(), Mover);
    const lie = movers as unknown as Storage<typeof Statue>;
    ${helper}
    const ids = [
        spawn(movers, { Position: { x: 1, y: 0 }, Velocity: { dx: 0, dy: 0 } }),
        spawn(movers, { Position: { x: 2, y: 0 }, Velocity: { dx: 0, dy: 0 } }),
    ];
    each(movers, (e) => {
        ${body}
        e.Position.x += 100;
    });
    return { xs: ids.map((id) => get(movers, id, Position.x)), rows: movers.n };
}
`;
      const TICK = "let ticks = 0;\n    const tick = (): void => { ticks += 1; };";
      const PICK = "const pick = (): typeof lie => lie;";

      it.each([
        {
          name: "a spawn beside another hazard point",
          helper: TICK,
          body: "tick(); spawn(lie);",
          rows: 4,
        },
        {
          name: "a spawnMany beside another hazard point",
          helper: TICK,
          body: "tick(); spawnMany(lie, 2);",
          rows: 6,
        },
        { name: "a spawn whose target is a call", helper: PICK, body: "spawn(pick());", rows: 4 },
        {
          name: "a spawnMany whose target is a call",
          helper: PICK,
          body: "spawnMany(pick(), 2);",
          rows: 6,
        },
      ])(
        "compiles $name realloc-safe, unguarded, and returns what the runtime returns",
        async ({ helper, body, rows }) => {
          const planned = await project.planned(CASE_PRELUDE + lyingSource(helper, body));
          const modules = {
            runtime: runtimeModule(planned),
            rewritten: await project.emitModule(planned, "planned"),
          };
          const expected = { xs: [101, 102], rows };

          const checked = await project.run(modules);
          const stripped = await project.run(modules, true);

          expect({ mode: rewriteAt(planned, 0).mode, checked, stripped }).toStrictEqual({
            mode: "realloc-safe",
            checked: { runtime: expected, rewritten: expected },
            stripped: { runtime: expected, rewritten: expected },
          });
        },
        RUN_TIMEOUT_MS,
      );
    });

    describe("when reading the storage arrays", () => {
      const HOISTS = [/\.x[,;]/u, /\.y[,;]/u, /\.entities[,;]/u, /\.mask[,;]/u];
      const INDEXES = [/\.x\[/u, /\.y\[/u, /\.entities\[/u, /\.mask\[/u];

      it("reads each column, the entity array, and the mask into locals before the loop in hoisted mode", async () => {
        const { text } = await project.rewrite(CASE_PRELUDE + MODE_SOURCE, { mode: "hoisted" });

        const { before, loops, inside } = splitAtLoops(text);
        expect(loops).not.toHaveLength(0);
        expect(HOISTS.filter((pattern) => !pattern.test(before))).toStrictEqual([]);
        expect(inside).toMatch(/\w+\[i\w*\] = \w+\[i\w*\] \+ \w+\[i\w*\]/u);
        expect(INDEXES.filter((pattern) => pattern.test(inside))).toStrictEqual([]);
      });

      it("reads every column, the entity array, and the mask through their owner on each access in realloc-safe mode", async () => {
        const { text } = await project.rewrite(CASE_PRELUDE + MODE_SOURCE, {
          mode: "realloc-safe",
        });

        const { before, loops, inside } = splitAtLoops(text);
        expect(loops).not.toHaveLength(0);
        expect(HOISTS.filter((pattern) => pattern.test(before))).toStrictEqual([]);
        expect(INDEXES.filter((pattern) => !pattern.test(inside))).toStrictEqual([]);
      });
    });

    it.each(MODES)(
      "declares every name once, user names under their own, in %s mode",
      async (mode) => {
        const source = `export function scenario(): unknown {
    const sized = register(createWorld(), Sized);
    const storage = 1, n = 2, i = 3, x = 4, entities = 5;
    let total = storage + n + i + x + entities;
    each(sized, (e) => {
        total += e.Position.x + e.Scale.x + e.id;
    });
    each(sized, (e) => {
        e.Scale.x = e.Position.x;
    });
    return total;
}
`;

        const { text } = await project.rewrite(CASE_PRELUDE + source, { mode });

        const counts = declarationCounts(text);
        expect(text.split(ROW_LOOP)).toHaveLength(3);
        expect([...counts].filter(([, count]) => count !== 1)).toStrictEqual([]);
        expect(
          ["sized", "storage", "n", "i", "x", "entities", "total"].filter(
            (name) => !counts.has(name),
          ),
        ).toStrictEqual([]);
      },
    );

    describe("when guarding the compiled shape", () => {
      /**
       * Casts an empty storage to a shape it lacks, in a file that binds `ecstatic_internal`,
       * `DEBUG` and `shapeKey` itself, which the guard's inline gate and literal key must not read.
       */
      const GUARD_SOURCE = `const ecstatic_internal = 0;
const DEBUG = false;
const shapeKey = "banana";

export function scenario(): unknown {
    const statues = register(createWorld(), Statue);
    const movers = statues as unknown as Storage<typeof Mover>;
    let rows = ecstatic_internal;
    try {
        each(movers, () => {
            rows += 1;
        });
    } catch (error) {
        return error instanceof Error ? error.message : "thrown";
    }
    return DEBUG ? shapeKey : "returned";
}
`;

      it(
        "throws naming the compiled shape before any row with DEBUG on, and returns as the runtime does under NDEBUG",
        async () => {
          const planned = await project.planned(CASE_PRELUDE + GUARD_SOURCE);
          const module = await project.emitModule(planned, "guarded");
          const key = shapeKey(rewriteAt(planned, 0).shape);

          const checked = await project.run({ rewritten: module });
          const stripped = await project.run({ rewritten: module }, true);

          expect(checked).toStrictEqual({
            rewritten: expect.stringContaining(`ecstatic: shape guard expected ${key}, got `),
          });
          expect(stripped).toStrictEqual({ rewritten: "returned" });
        },
        RUN_TIMEOUT_MS,
      );

      it("guards each loop with its own site's shape key", async () => {
        const planned = await project.planned(PREAMBLE_SOURCE);

        const { text } = await project.emit(planned);

        expect(guards(text)).toStrictEqual(planned.rewrites.map(({ shape }) => shapeKey(shape)));
        expect(new Set(guards(text)).size).toBe(2);
      });
    });

    describe("when guarding a literal filter's elements", () => {
      /** A module whose filtered loop casts a component's type, reporting the throw, rows, and matchers. */
      const filterGuardSource = (
        lie: string,
        filter: string,
        actual: string,
        expectPresent: boolean,
      ): string => `import { assertFilterMember } from "../src/ecstatic/internal.js";
${CASE_PRELUDE}
export function scenario(): unknown {
    const { storage } = guarded();
    const lie = ${lie};
    const visited: number[] = [];
    let outcome = "returned";
    try {
        each(storage, ${filter}, (e) => {
            visited.push(e.Position.x);
        });
    } catch (error) {
        outcome = error instanceof Error ? error.message : "thrown";
    }
    try {
        assertFilterMember(storage, ${actual}, ${String(expectPresent)});
    } catch (error) {
        if (error instanceof Error && error.message === outcome) outcome = "filter guard";
    }
    return { outcome, visited, matchers: storage.matchers.length };
}
`;

      it.each([
        {
          name: "an element present where the fold took it absent and dropped the filter",
          lie: "Shield as unknown as typeof Velocity",
          filter: "{ none: [lie] }",
          actual: "Shield",
          expectPresent: false,
          stripped: { outcome: "returned", visited: [2, 1], matchers: 0 },
        },
        {
          name: "an element absent where the fold took it present and built a matcher",
          lie: "Velocity as unknown as typeof Shield",
          filter: "{ all: [lie] }",
          actual: "Velocity",
          expectPresent: true,
          stripped: { outcome: "returned", visited: [1], matchers: 1 },
        },
        {
          name: "an element present where the fold took it absent and skipped the pass",
          lie: "Shield as unknown as typeof Velocity",
          filter: "{ all: [lie] }",
          actual: "Shield",
          expectPresent: false,
          stripped: { outcome: "returned", visited: [], matchers: 0 },
        },
      ])(
        "guards the fold's element presence only with DEBUG on, for $name",
        async ({ lie, filter, actual, expectPresent, stripped: expectedStripped }) => {
          const planned = await project.planned(
            filterGuardSource(lie, filter, actual, expectPresent),
          );
          const module = await project.emitModule(planned, "filter-guarded");

          const { checked, stripped } = await project.runSettings({ rewritten: module });

          expect({ checked, stripped }).toStrictEqual({
            checked: { rewritten: { outcome: "filter guard", visited: [], matchers: 0 } },
            stripped: { rewritten: expectedStripped },
          });
        },
        RUN_TIMEOUT_MS,
      );
    });

    describe("when adding the file preamble", () => {
      it("adds the internal import once and gates every guard with the runtime's DEBUG initializer", async () => {
        const planned = await project.planned(PREAMBLE_SOURCE);

        const { text } = await project.emit(planned);

        expect(text.split('from "ecstatic/internal"')).toHaveLength(2);
        expect(ndebugLines(text)).toStrictEqual(
          planned.rewrites.map(() => expect.stringMatching(RUNTIME_GATED_GUARD)),
        );
      });

      it("gates the guards with the DEBUG initializer of the runtime root it is given", async () => {
        const root = writeProject({
          "src/ecstatic/debug.ts": `declare const NDEBUG: unknown;

/** Whether the checks run. */
export const DEBUG: boolean = typeof NDEBUG !== "string";
`,
        });

        const planned = await project.planned(PREAMBLE_SOURCE);

        const { text } = await project.emit(planned, { root });

        expect(ndebugLines(text)).toStrictEqual(
          planned.rewrites.map(() => expect.stringMatching(ROOT_GATED_GUARD)),
        );
      });

      it("rejects naming the runtime root's debug module when it cannot be read", async () => {
        const root = writeProject({ "src/ecstatic/index.ts": "export {};\n" });

        const rewriting = project.rewrite(PREAMBLE_SOURCE, { root });

        await expect(rewriting).rejects.toThrow(projectPath(root, "src/ecstatic/debug.ts"));
      });
    });

    describe("when inlining a site throws once its loop is built", () => {
      it.each([
        {
          name: "the first site, whose loop allocated the preamble's namespace name",
          failing: [0],
        },
        { name: "the one site of its shape, whose guard carries its own shape key", failing: [1] },
        { name: "every site, so no loop is left to need the preamble", failing: [0, 1, 2] },
      ])("leaves the file as it was for $name", async ({ failing }) => {
        const planned = await project.planned(PREAMBLE_SOURCE);
        const failingCalls = new Set(failing.map((index) => rewriteAt(planned, index).call));
        const expected = await project.emit(planned, {
          inline: (file, inlining, uses) => {
            if (!failingCalls.has(inlining.call)) file.inline(inlining, uses);
          },
        });
        const thrown: unknown[] = [];

        const actual = await project.emit(planned, {
          beforeCommit: (inlining) => {
            if (failingCalls.has(inlining.call)) throw new Error("banana split");
          },
          inline: (file, inlining, uses) => {
            try {
              file.inline(inlining, uses);
            } catch (error) {
              thrown.push(error instanceof Error ? error.message : error);
            }
          },
        });

        expect(thrown).toStrictEqual(failing.map(() => "banana split"));
        expect(actual).toStrictEqual(expected);
      });
    });
  });
});
