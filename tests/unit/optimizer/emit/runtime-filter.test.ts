import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { closeProject, SPAWN_TIMEOUT_MS } from "../project.js";
import {
  EmitProject,
  everyRun,
  filterOutcome,
  rewriteAt,
  RUN_TIMEOUT_MS,
  writeCycle,
} from "./emit-project.js";

let project: EmitProject;

beforeAll(async () => {
  project = await EmitProject.open();
}, SPAWN_TIMEOUT_MS);

afterAll(() => closeProject(project.session));

/**
 * The entry module of a cycle whose `total` sums, over a Guarded storage, the rows an inlined loop
 * visits for a filter held in a binding, which is resolved at runtime.
 */
const CYCLE_ENTRY_SOURCE = `import { each, type EachFilter } from "../src/ecstatic/index.js";
import { Shield, guarded } from "../app/schema.js";
import { early } from "./partner.js";

export function total(): number {
    const { storage } = guarded();
    const filter: EachFilter = { all: [Shield] };
    let sum = 0;
    each(storage, filter, (e) => {
        sum += e.Position.x;
    });
    return sum;
}

export function scenario(): unknown {
    return early;
}
`;

describe("EmitFile inline when the filter is not a literal", () => {
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
      source: `export function scenario(): unknown {
    const lie = register(createWorld(), Statue) as unknown as Storage<typeof Mover>;
    const outcomes: unknown[] = [];
    for (const value of [null, 42, undefined, "all"]) {
        try {
            each(lie, value as unknown as EachFilter, () => {
                outcomes.push("row");
            });
            outcomes.push("returned");
        } catch (error) {
            outcomes.push(error instanceof Error ? error.message : typeof error);
        }
    }
    return outcomes;
}
`,
      expected: Array.from({ length: 4 }, () => "invalid each arguments"),
    },
    {
      name: "a change to the storage, the filter object, an axis, its length, or an element is seen on the next call",
      source: `export function scenario(): unknown {
    const { storage } = guarded();
    const other = register(createWorld(), Guarded);
    spawn(other, { Position: { x: 7, y: 0 }, Boost: true });
    spawn(other, { Position: { x: 8, y: 0 }, Shield: { hp: 1 } });
    const all: (typeof Shield | typeof Velocity | typeof Flags)[] = [Shield];
    const filter: { all: (typeof Shield | typeof Velocity | typeof Flags)[]; none?: (typeof Boost)[] } = { all };
    const shielded = { all: [Shield] };
    const seen: number[][] = [];
    seen.push(visit(storage, filter));
    seen.push(visit(storage, filter));
    all.pop();
    seen.push(visit(storage, filter));
    all.push(Velocity);
    seen.push(visit(storage, filter));
    all[0] = Shield;
    seen.push(visit(storage, filter));
    filter.all = [Flags];
    seen.push(visit(storage, filter));
    filter.none = [Boost];
    seen.push(visit(storage, filter));
    seen.push(visit(storage, shielded));
    seen.push(visit(other, shielded));
    seen.push(visit(storage, shielded));
    return { seen, matchers: [storage.matchers.length, other.matchers.length] };
}
`,
      expected: {
        seen: [[1], [1], [2, 1], [], [1], [2, 1], [2], [1], [8], [1]],
        matchers: [2, 1],
      },
    },
    {
      name: "a filter no row can match visits nothing, a trivial one every row, and any other registers its matcher first, even on an empty storage",
      source: `export function scenario(): unknown {
    const empty = register(createWorld(), Guarded);
    const storage = register(createWorld(), Guarded);
    const registered = (s: Storage<typeof Guarded>): number[][] =>
        s.matchers.map((m) => [m.allMask, m.anyMask, m.noneMask]);
    const skipped: EachFilter = { all: [Velocity] };
    const trivial: EachFilter = { all: [Position], any: [Stunned] };
    const masked: EachFilter = { any: [Shield, Boost] };
    const onEmpty = [visit(empty, masked), registered(empty)];
    spawn(storage, { Position: { x: 1, y: 0 }, Shield: { hp: 1 } });
    spawn(storage, { Position: { x: 2, y: 0 } });
    spawn(storage, { Position: { x: 3, y: 0 }, Boost: true });
    const outcomes = [skipped, trivial, masked].map((f) => [visit(storage, f), registered(storage)]);
    return { onEmpty, outcomes };
}
`,
      expected: {
        onEmpty: [[], [[0, 3, 0]]],
        outcomes: [
          [[], []],
          [[3, 2, 1], []],
          [[3, 1], [[0, 3, 0]]],
        ],
      },
    },
    {
      name: "the call's scope binds its own Array and Error",
      source: `export function scenario(): unknown {
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
        outcomes.push(error instanceof globalThis.Error ? error.message : "not the runtime's error");
    }
    return outcomes;
}
`,
      expected: [true, "a local error", 1, "invalid each arguments"],
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

      const results = await project.runEverySetting(BINDING_PRELUDE + source, ["realloc-safe"]);

      expect(results).toStrictEqual(everyRun({ seen: [3, 2], rows: 103 }, ["realloc-safe"]));
    },
    RUN_TIMEOUT_MS,
  );

  it(
    "runs the loop as the runtime call does when a circular import calls it before its module has run, with checks on and stripped",
    async () => {
      const planned = await project.planned(CYCLE_ENTRY_SOURCE);
      const { text } = await project.emit(planned);
      const modules = {
        runtime: writeCycle(project.root, "cycle-runtime-filter-runtime", CYCLE_ENTRY_SOURCE),
        rewritten: writeCycle(project.root, "cycle-runtime-filter-rewritten", text),
      };

      const checked = await project.run(modules);
      const stripped = await project.run(modules, true);

      expect({ outcome: filterOutcome(rewriteAt(planned, 0)), checked, stripped }).toStrictEqual({
        outcome: "runtime",
        checked: { runtime: 1, rewritten: 1 },
        stripped: { runtime: 1, rewritten: 1 },
      });
    },
    RUN_TIMEOUT_MS,
  );
});
