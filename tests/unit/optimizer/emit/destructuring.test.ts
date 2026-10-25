import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { closeProject, SPAWN_TIMEOUT_MS } from "../project.js";
import { EmitProject, everyRun, RUN_TIMEOUT_MS, type RunCase } from "./emit-project.js";

let project: EmitProject;

beforeAll(async () => {
  project = await EmitProject.open();
}, SPAWN_TIMEOUT_MS);

afterAll(() => closeProject(project.session));

/** Scenarios that destructure the view or a slot in the body or the callback's parameter. */
const PATTERN_CASES: readonly RunCase[] = [
  {
    name: "const and let declarations of a slot copy its fields, renamed or not, and let bindings stay assignable",
    source: `export function scenario(): unknown {
    const movers = register(createWorld(), Mover);
    const ids = [
        spawn(movers, { Position: { x: 1, y: 2 }, Velocity: { dx: 3, dy: 4 } }),
        spawn(movers, { Position: { x: 5, y: 6 }, Velocity: { dx: 7, dy: 8 } }),
    ];
    const trace: unknown[] = [];
    each(movers, (e) => {
        const { x, y: py } = e.Position;
        let { dx: vx, dy } = e.Velocity;
        vx += 100;
        dy = x;
        e.Position.x = vx;
        trace.push(x, py, vx, dy, e.Position.x);
    });
    return { trace, xs: ids.map((id) => get(movers, id, Position.x)) };
}
`,
    expected: { trace: [5, 6, 107, 5, 107, 1, 2, 103, 1, 103], xs: [103, 107] },
  },
  {
    name: "the view destructured in the body binds id, slot aliases, depth-one reads, and tags",
    source: `export function scenario(): unknown {
    const { storage, ids } = guarded();
    const trace: unknown[] = [];
    each(storage, (e) => {
        const { id, Position, Flags: { on }, Stunned, Boost } = e;
        Position.x += 10;
        trace.push(ids.indexOf(id), Position.x, on, Stunned, Boost);
    });
    return { trace, xs: ids.map((id) => get(storage, id, Position.x)) };
}
`,
    expected: { trace: [1, 12, false, true, null, 0, 11, true, true, true], xs: [11, 12] },
  },
  {
    name: "destructuring a disabled optional slot throws a TypeError, even with no field",
    source: `export function scenario(): unknown {
    const { storage } = guarded();
    const trace: unknown[] = [];
    each(storage, (e) => {
        try {
            const { hp, up, level: lv } = e.Shield!;
            trace.push(hp, up, lv);
        } catch (error) {
            trace.push("fields", error instanceof TypeError);
        }
        try {
            const {} = e.Shield!;
            trace.push("empty");
        } catch (error) {
            trace.push("empty", error instanceof TypeError);
        }
    });
    return trace;
}
`,
    expected: ["fields", true, "empty", true, 5, true, 2, "empty"],
  },
  {
    name: "a field default never applies on a typed-array column and applies to undefined on a plain-array one, in pattern order",
    source: `export function scenario(): unknown {
    const { storage } = marked();
    const trace: unknown[] = [];
    each(storage, (e) => {
        const { x = (trace.push("x default"), -1) } = e.Position;
        trace.push(x);
        if (e.Mark) {
            const { first = (trace.push("first default"), (e.Mark.second = 9), 1), second = (trace.push("second default"), 2) } = e.Mark;
            trace.push(first, second);
        }
    });
    return trace;
}
`,
    expected: [2, 1, "first default", 1, 9],
  },
  {
    name: "a default that disables the slot leaves the rest of the pattern reading its columns",
    source: `export function scenario(): unknown {
    const { storage } = marked();
    const trace: unknown[] = [];
    each(storage, (e) => {
        if (e.Mark) {
            const { first = (disable(storage, e.id, Mark), 3), second = 4 } = e.Mark;
            trace.push(first, second, e.Mark === undefined);
            enable(storage, e.id, Mark);
        }
    });
    return trace;
}
`,
    expected: [3, 4, true],
  },
  {
    name: "a parameter pattern binds id, aliases, and nested reads, and its bindings stay assignable",
    source: `export function scenario(): unknown {
    const movers = register(createWorld(), Mover);
    const ids = [
        spawn(movers, { Position: { x: 1, y: 2 }, Velocity: { dx: 3, dy: 4 } }),
        spawn(movers, { Position: { x: 5, y: 6 }, Velocity: { dx: 7, dy: 8 } }),
    ];
    const trace: unknown[] = [];
    each(movers, ({ id, Position: p, Velocity: { dx: vx, dy } }) => {
        p.x += vx;
        vx = 0;
        dy *= 2;
        trace.push(ids.indexOf(id), p.x, vx, dy);
    });
    return { trace, xs: ids.map((id) => get(movers, id, Position.x)) };
}
`,
    expected: { trace: [1, 12, 0, 16, 0, 4, 0, 8], xs: [4, 12] },
  },
  {
    name: "shorthand slot parameters alias the records, so writes through them reach the columns",
    source: `export function scenario(): unknown {
    const movers = register(createWorld(), Mover);
    const ids = [
        spawn(movers, { Position: { x: 1, y: 0 }, Velocity: { dx: 2, dy: 0 } }),
        spawn(movers, { Position: { x: 3, y: 0 }, Velocity: { dx: 4, dy: 0 } }),
    ];
    each(movers, ({ Position, Velocity }) => {
        Position.x += Velocity.dx;
        Velocity.dx = 0;
    });
    return { xs: ids.map((id) => get(movers, id, Position.x)), dxs: ids.map((id) => get(movers, id, Velocity.dx)) };
}
`,
    expected: { xs: [3, 7], dxs: [0, 0] },
  },
  {
    name: "parameter defaults see the enclosing scope but not the names the body declares",
    source: `export function scenario(): unknown {
    const pins = register(createWorld(), Pinned);
    spawn(pins, { Mark: { first: 5 } });
    spawn(pins, {});
    const trace: unknown[] = [];
    const fallback = 100;
    each(pins, ({ Mark: { first = fallback, second = first } }) => {
        const fallback = 200;
        first += 1;
        trace.push(first, second, fallback);
    });
    return trace;
}
`,
    expected: [101, 100, 200, 6, 5, 200],
  },
  {
    name: "a parameter pattern destructuring a disabled optional slot throws a TypeError before the body runs",
    source: `export function scenario(): unknown {
    const { storage } = guarded();
    const trace: unknown[] = [];
    try {
        // @ts-expect-error -- the type rejects destructuring an optional slot, which the runtime does when it is disabled
        each(storage, ({ Shield: { hp } }) => {
            trace.push(hp);
        });
    } catch (error) {
        trace.push(error instanceof TypeError);
    }
    return trace;
}
`,
    expected: [true],
  },
  {
    name: "an expression-bodied callback destructures tags, an optional alias, and depth-one reads",
    source: `export function scenario(): unknown {
    const { storage } = guarded();
    const trace: unknown[] = [];
    each(storage, ({ Stunned, Boost, Shield, Position: { x }, Flags: { on } }) => trace.push(Stunned, Boost, Shield?.hp, Shield === undefined, x, on));
    return trace;
}
`,
    expected: [true, null, null, true, 2, false, true, true, 5, false, 1, true],
  },
  {
    name: "pattern bindings are fresh on every row, and a pattern at depth two runs on the field value",
    source: `export function scenario(): unknown {
    const statues = register(createWorld(), Statue);
    spawn(statues, { Position: { x: 1, y: 0 }, Label: { text: "ab" } });
    spawn(statues, { Position: { x: 2, y: 0 }, Label: { text: "cde" } });
    const reads: (() => unknown)[] = [];
    each(statues, ({ Position: { x }, Label: { text: { length: size } } }) => {
        reads.push(() => [x, size]);
    });
    return reads.map((read) => read());
}
`,
    expected: [
      [2, 3],
      [1, 2],
    ],
  },
  {
    name: "the data fields of required and optional relation slots destructure like a component's",
    source: `export function scenario(): unknown {
    const world = createWorld();
    const anchor = spawn(register(world, Mover), { Position: { x: 0, y: 0 } });
    const tethered = register(world, Tethered);
    spawn(tethered, { Tether: { target: anchor, slack: 2 }, Leash: { target: anchor, length: 4 } });
    spawn(tethered, { Tether: { target: anchor, slack: 5 } });
    const trace: unknown[] = [];
    each(tethered, ({ Tether: { slack }, Leash }) => {
        trace.push(slack, Leash?.length);
    });
    return trace;
}
`,
    expected: [5, null, 2, 4],
  },
];

describe("EmitFile", () => {
  describe("inline", () => {
    it.each(PATTERN_CASES)(
      "lowers destructuring as the runtime evaluates it: $name",
      async ({ source, expected }) => {
        const results = await project.runEverySetting(source);

        expect(results).toStrictEqual(everyRun(expected));
      },
      RUN_TIMEOUT_MS,
    );
  });
});
