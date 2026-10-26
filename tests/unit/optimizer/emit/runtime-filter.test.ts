import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Mode } from "../../../../src/plugin/optimizer/plan.js";
import { closeProject, SPAWN_TIMEOUT_MS } from "../project.js";
import { EmitProject, everyRun, RUN_TIMEOUT_MS } from "./emit-project.js";

let project: EmitProject;

beforeAll(async () => {
  project = await EmitProject.open();
}, SPAWN_TIMEOUT_MS);

afterAll(() => closeProject(project.session));

/**
 * Binds `invalidArgumentsMessage`, the message the runtime throws for an `each` call it cannot
 * resolve, outside any scenario scope so a scenario that shadows `Error` still reads the real one.
 */
const INVALID_ARGUMENTS_SOURCE = `import { throwInvalidEachArguments } from "../src/ecstatic/internal.js";

function invalidArgumentsMessage(): string {
    try {
        throwInvalidEachArguments();
    } catch (error) {
        return error instanceof Error ? error.message : "thrown";
    }
}

`;

describe("EmitFile", () => {
  describe("inline", () => {
    describe("when the filter is not a literal", () => {
      /**
       * Opens a case whose filters are bindings: the filter type, the components the prelude lacks,
       * and `visit`, one call site that records the Position.x of each row a filter visits.
       */
      const BINDING_PRELUDE = `import type { EachFilter } from "../src/ecstatic/index.js";
import { Boost, Guarded, Stunned } from "./schema.js";

function visit(storage: Storage<typeof Guarded>, filter: EachFilter): number[] {
    const seen: number[] = [];
    each(storage, filter, (e) => {
        seen.push(e.Position.x);
    });
    return seen;
}
`;

      const VISITED = "visited";

      const VISITED_WITH_MASKS =
        "[visited, storage.matchers.map((m) => [m.allMask, m.anyMask, m.noneMask])]";

      /**
       * A scenario visiting a fresh Guarded storage with `filter` through `visit` and returning
       * `returned`, an expression over `visited` (the rows visited) and `storage`. The storage
       * holds three rows when `withRows`.
       */
      function filterSource(filter: string, withRows: boolean, returned: string): string {
        const spawns = withRows
          ? `    spawn(storage, { Position: { x: 1, y: 0 }, Shield: { hp: 1 } });
    spawn(storage, { Position: { x: 2, y: 0 } });
    spawn(storage, { Position: { x: 3, y: 0 }, Boost: true });
`
          : "";
        return `export function scenario(): unknown {
    const storage = register(createWorld(), Guarded);
${spawns}    const filter: EachFilter = ${filter};
    const visited = visit(storage, filter);
    return ${returned};
}
`;
      }

      it.each([
        {
          name: "the storage, the filter, then each axis are evaluated once per call, before any row, on a miss and on a hit",
          source: `export function scenario(): unknown {
    const { storage } = guarded();
    const trace: unknown[] = [];
    const pick = <T,>(label: string, value: T): T => {
        trace.push(label);
        return value;
    };
    const all = [Shield];
    const any = [Shield, Boost];
    const none: (typeof Stunned)[] = [];
    const filter: EachFilter = {
        get all() {
            trace.push("all");
            return all;
        },
        get any() {
            trace.push("any");
            return any;
        },
        get none() {
            trace.push("none");
            return none;
        },
    };
    for (const round of [1, 2]) {
        trace.push("round", round);
        each(pick("storage", storage), pick("filter", filter), (e) => {
            trace.push("row", e.Position.x);
        });
    }
    return trace;
}
`,
          expected: [
            "round",
            1,
            "storage",
            "filter",
            "all",
            "any",
            "none",
            "row",
            1,
            "round",
            2,
            "storage",
            "filter",
            "all",
            "any",
            "none",
            "row",
            1,
          ],
        },
        {
          name: "a filter value that is null or not an object throws before the shape guard",
          source: `${INVALID_ARGUMENTS_SOURCE}export function scenario(): unknown {
    const lie = register(createWorld(), Statue) as unknown as Storage<typeof Mover>;
    const outcomes: unknown[] = [];
    for (const value of [null, 42]) {
        try {
            each(lie, value as unknown as EachFilter, () => {
                outcomes.push("row");
            });
            outcomes.push("returned");
        } catch (error) {
            const message = error instanceof Error ? error.message : typeof error;
            outcomes.push(message === invalidArgumentsMessage() ? "invalid arguments" : message);
        }
    }
    return outcomes;
}
`,
          expected: ["invalid arguments", "invalid arguments"],
        },
        {
          name: "a different storage is seen on the next call",
          source: `export function scenario(): unknown {
    const { storage } = guarded();
    const other = register(createWorld(), Guarded);
    spawn(other, { Position: { x: 7, y: 0 }, Boost: true });
    spawn(other, { Position: { x: 8, y: 0 }, Shield: { hp: 1 } });
    const shielded = { all: [Shield] };
    const seen: number[][] = [];
    seen.push(visit(storage, shielded));
    seen.push(visit(other, shielded));
    seen.push(visit(storage, shielded));
    return seen;
}
`,
          expected: [[1], [8], [1]],
        },
        {
          name: "a different filter object is seen on the next call",
          source: `export function scenario(): unknown {
    const { storage } = guarded();
    const shielded = { all: [Shield] };
    const withoutBoost = { all: [Flags], none: [Boost] };
    const seen: number[][] = [];
    seen.push(visit(storage, shielded));
    seen.push(visit(storage, withoutBoost));
    seen.push(visit(storage, shielded));
    return seen;
}
`,
          expected: [[1], [2], [1]],
        },
        {
          name: "a replaced or added axis is seen on the next call",
          source: `export function scenario(): unknown {
    const { storage } = guarded();
    const filter: { all: (typeof Shield | typeof Flags)[]; none?: (typeof Boost)[] } = { all: [Shield] };
    const seen: number[][] = [];
    seen.push(visit(storage, filter));
    filter.all = [Flags];
    seen.push(visit(storage, filter));
    filter.none = [Boost];
    seen.push(visit(storage, filter));
    return seen;
}
`,
          expected: [[1], [2, 1], [2]],
        },
        {
          name: "a change to an axis's length is seen on the next call",
          source: `export function scenario(): unknown {
    const { storage } = guarded();
    const all = [Shield];
    const filter = { all };
    const seen: number[][] = [];
    seen.push(visit(storage, filter));
    seen.push(visit(storage, filter));
    all.pop();
    seen.push(visit(storage, filter));
    all.push(Shield);
    seen.push(visit(storage, filter));
    return seen;
}
`,
          expected: [[1], [1], [2, 1], [1]],
        },
        {
          name: "a change to an element of an axis is seen on the next call",
          source: `export function scenario(): unknown {
    const { storage } = guarded();
    const all: (typeof Shield | typeof Velocity)[] = [Shield];
    const filter = { all };
    const seen: number[][] = [];
    seen.push(visit(storage, filter));
    all[0] = Velocity;
    seen.push(visit(storage, filter));
    all[0] = Shield;
    seen.push(visit(storage, filter));
    return seen;
}
`,
          expected: [[1], [], [1]],
        },
        {
          name: "a filter no row can match visits nothing",
          source: filterSource("{ all: [Velocity] }", true, VISITED),
          expected: [],
        },
        {
          name: "a trivial filter visits every row",
          source: filterSource("{ all: [Position], any: [Stunned] }", true, VISITED),
          expected: [3, 2, 1],
        },
        {
          name: "any other filter registers its matcher and visits the rows it flags",
          source: filterSource("{ any: [Shield, Boost] }", true, VISITED_WITH_MASKS),
          expected: [[3, 1], [[0, 3, 0]]],
        },
        {
          name: "any other filter registers its matcher first, even on an empty storage",
          source: filterSource("{ any: [Shield, Boost] }", false, VISITED_WITH_MASKS),
          expected: [[], [[0, 3, 0]]],
        },
        {
          name: "the call's scope binds its own Array and Error",
          source: `${INVALID_ARGUMENTS_SOURCE}export function scenario(): unknown {
    const Array = { isArray: (_value: unknown): boolean => true };
    const Error = class {
        readonly message = "a local error";
    };
    const { storage } = guarded();
    const either = (): EachFilter | readonly [typeof Shield] => ({ all: [Shield] });
    const outcomes: unknown[] = [Array.isArray(null), new Error().message];
    each(storage, either(), (e) => {
        outcomes.push(e.Position.x);
    });
    try {
        each(storage, 42 as unknown as EachFilter, () => {
            outcomes.push("row");
        });
    } catch (error) {
        const message = error instanceof globalThis.Error ? error.message : "not the runtime's error";
        outcomes.push(message === invalidArgumentsMessage() ? "invalid arguments" : message);
    }
    return outcomes;
}
`,
          expected: [true, "a local error", 1, "invalid arguments"],
        },
        {
          name: "an enable or disable in the body changes which rows not yet visited are visited",
          source: `export function scenario(): unknown {
    const storage = register(createWorld(), Guarded);
    const first = spawn(storage, { Position: { x: 1, y: 0 }, Shield: { hp: 1 } });
    const second = spawn(storage, { Position: { x: 2, y: 0 } });
    spawn(storage, { Position: { x: 3, y: 0 }, Boost: true });
    const filter: EachFilter = { any: [Shield, Boost] };
    const seen: number[] = [];
    each(storage, filter, (e) => {
        seen.push(e.Position.x);
        if (e.Position.x === 3) {
            disable(storage, first, Shield);
            enable(storage, second, Boost);
        }
    });
    return seen;
}
`,
          expected: [3, 2],
        },
      ])(
        "runs the loop as the runtime call does, with checks on and stripped, when $name",
        async ({ source, expected }) => {
          const results = await project.runEverySetting(BINDING_PRELUDE + source);

          expect(results).toStrictEqual(everyRun(expected));
        },
        RUN_TIMEOUT_MS,
      );

      it(
        "visits only the rows the matcher flags after the body grows the storage past its capacity, in realloc-safe mode",
        async () => {
          const source = `export function scenario(): unknown {
    const storage = register(createWorld(), Guarded);
    const first = spawn(storage, { Position: { x: 1, y: 0 }, Shield: { hp: 1 } });
    spawn(storage, { Position: { x: 2, y: 0 }, Shield: { hp: 2 } });
    spawn(storage, { Position: { x: 3, y: 0 }, Shield: { hp: 3 } });
    const filter = [Shield] as const;
    const seen: number[] = [];
    each(storage, filter, (e) => {
        seen.push(e.Position.x);
        if (e.Position.x === 3) {
            spawnMany(storage, 100, { Shield: { hp: 9 } });
            disable(storage, first, Shield);
        }
    });
    return { seen, rows: storage.n };
}
`;

          const modes: readonly Mode[] = ["realloc-safe"];

          const results = await project.runEverySetting(BINDING_PRELUDE + source, modes);

          expect(results).toStrictEqual(everyRun({ seen: [3, 2], rows: 103 }, modes));
        },
        RUN_TIMEOUT_MS,
      );
    });
  });
});
