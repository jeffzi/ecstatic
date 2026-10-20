import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { closeProject, SPAWN_TIMEOUT_MS } from "../project.js";
import {
  EmitProject,
  everyRun,
  RUN_TIMEOUT_MS,
  type RunCase,
  THREE_MOVERS,
} from "./emit-project.js";

let project: EmitProject;

beforeAll(async () => {
  project = await EmitProject.open();
}, SPAWN_TIMEOUT_MS);

afterAll(() => closeProject(project.session));

/** Opens a scenario over a Paired storage of two rows whose "A,B".n is 1, then 3, and Position.x 2, then 4. */
const PAIRS = `export function scenario(): unknown {
    const pairs = register(createWorld(), Paired);
    const ids = [
        spawn(pairs, { "A,B": { n: 1 }, Position: { x: 2, y: 0 } }),
        spawn(pairs, { "A,B": { n: 3 }, Position: { x: 4, y: 0 } }),
    ];
    const trace: unknown[] = [];
`;

/**
 * Opens a scenario over two movers whose `grow` spawns past the storage's capacity, then returns
 * the value it was given.
 */
const GROWING_MOVERS = `export function scenario(): unknown {
    const movers = register(createWorld(), Mover);
    const ids = [
        spawn(movers, { Position: { x: 1, y: 0 }, Velocity: { dx: 0, dy: 3 } }),
        spawn(movers, { Position: { x: 2, y: 0 }, Velocity: { dx: 0, dy: 3 } }),
    ];
    type Id = (typeof ids)[number];
    const grow = (value: number): number => {
        spawnMany(movers, 20);
        return value;
    };
    const column = (read: (id: Id) => unknown) => ids.map(read);
`;

/** The movers' Position.x column, as a property of the object a growing scenario returns. */
const XS = "xs: column((id) => get(movers, id, Position.x))";

/** Scenarios over every view reference the rewrite lowers. */
const VIEW_CASES: readonly RunCase[] = [
  {
    name: "required fields take compound, logical, and update forms",
    source: `export function scenario(): unknown {
    const { storage, ids } = guarded();
    const trace: unknown[] = [];
    each(storage, (e) => {
        e.Position.x += 10;
        e.Position.x *= 2;
        e.Position.y ||= 7;
        e.Position.y &&= e.Position.y + 1;
        e.Position.y ??= 0;
        trace.push(e.Position.x++, ++e.Position.x, e.Position.y--, --e.Position.y, e.Position!.x);
    });
    return { trace, xs: ids.map((id) => get(storage, id, Position.x)) };
}
`,
    expected: { trace: [24, 26, 8, 6, 26, 22, 24, 8, 6, 24], xs: [24, 26] },
  },
  {
    name: "optional fields of an enabled slot take every read and write form",
    source: `export function scenario(): unknown {
    const { storage, ids } = guarded();
    const trace: unknown[] = [];
    each(storage, (e) => {
        if (e.Shield) {
            e.Shield.hp += 1;
            e.Shield.hp ||= 3;
            e.Shield.hp &&= e.Shield.hp * 2;
            e.Shield.level += 300;
            e.Shield!.hp -= 1;
            trace.push(e.Shield.hp++, --e.Shield.hp, e.Shield.level, e.Shield!.hp);
        } else {
            trace.push("disabled");
        }
    });
    return { trace, hp: get(storage, ids[0]!, Shield.hp), level: get(storage, ids[0]!, Shield.level) };
}
`,
    expected: { trace: ["disabled", 11, 11, 46, 11], hp: 11, level: 46 },
  },
  {
    name: "a field of a disabled optional throws a TypeError at each read and write",
    source: `export function scenario(): unknown {
    const { storage } = guarded();
    const trace: unknown[] = [];
    each(storage, (e) => {
        try {
            trace.push(e.Shield!.hp);
        } catch (error) {
            trace.push("read", error instanceof TypeError);
        }
        try {
            e.Shield!.hp = 1;
        } catch (error) {
            trace.push("write", error instanceof TypeError);
        }
        try {
            e.Shield!.hp += 1;
        } catch (error) {
            trace.push("compound", error instanceof TypeError);
        }
        try {
            e.Shield!.hp++;
        } catch (error) {
            trace.push("update", error instanceof TypeError);
        }
    });
    return trace;
}
`,
    expected: ["read", true, "write", true, "compound", true, "update", true, 5],
  },
  {
    name: "a disable earlier in the callback makes the next field read throw",
    source: `export function scenario(): unknown {
    const { storage } = guarded();
    const trace: unknown[] = [];
    each(storage, (e) => {
        if (e.Shield) {
            trace.push(e.Shield.hp);
            disable(storage, e.id, Shield);
            try {
                trace.push(e.Shield.hp);
            } catch (error) {
                trace.push(error instanceof TypeError);
            }
        }
    });
    return trace;
}
`,
    expected: [5, true],
  },
  {
    name: "a right-hand side that disables the optional it writes does not make the write throw",
    source: `export function scenario(): unknown {
    const { storage, ids } = guarded();
    const trace: unknown[] = [];
    each(storage, (e) => {
        if (e.Shield) {
            e.Shield.hp = (disable(storage, e.id, Shield), 7);
            enable(storage, e.id, Shield);
            e.Shield.hp += (disable(storage, e.id, Shield), 1);
            enable(storage, e.id, Shield);
            e.Shield.up = (disable(storage, e.id, Shield), false);
            enable(storage, e.id, Shield);
            trace.push((e.Shield.up = (disable(storage, e.id, Shield), true)));
            enable(storage, e.id, Shield);
            e.Shield.up = false;
            trace.push((e.Shield.up ||= (disable(storage, e.id, Shield), true)));
            enable(storage, e.id, Shield);
        }
    });
    return { trace, hp: get(storage, ids[0]!, Shield.hp), up: get(storage, ids[0]!, Shield.up) };
}
`,
    expected: { trace: [true, true], hp: 8, up: true },
  },
  {
    name: "a disable earlier in the callback makes the next field write throw",
    source: `export function scenario(): unknown {
    const { storage, ids } = guarded();
    const trace: unknown[] = [];
    each(storage, (e) => {
        if (e.Shield) {
            e.Shield.hp = 6;
            disable(storage, e.id, Shield);
            try {
                e.Shield.hp = 7;
            } catch (error) {
                trace.push("write", error instanceof TypeError);
            }
            try {
                e.Shield.hp += 1;
            } catch (error) {
                trace.push("compound", error instanceof TypeError);
            }
        }
    });
    return { trace, shielded: ids.map((id) => has(storage, id, Shield)) };
}
`,
    expected: { trace: ["write", true, "compound", true], shielded: [false, false] },
  },
  {
    name: "boolean fields read as true and false and store what was assigned",
    source: `export function scenario(): unknown {
    const { storage, ids } = guarded();
    const trace: unknown[] = [];
    each(storage, (e) => {
        trace.push(e.Flags.on, !e.Flags.on);
        e.Flags.on = !e.Flags.on;
        if (e.Shield) {
            trace.push(e.Shield.up);
            e.Shield.up = false;
            trace.push(e.Shield.up);
        }
    });
    return { trace, on: ids.map((id) => get(storage, id, Flags.on)), up: get(storage, ids[0]!, Shield.up) };
}
`,
    expected: { trace: [false, true, true, false, true, false], on: [false, true], up: false },
  },
  {
    name: "a boolean assignment yields the assigned value, or the current one when a logical form short-circuits",
    source: `export function scenario(): unknown {
    const { storage } = guarded();
    const trace: unknown[] = [];
    each(storage, (e) => {
        trace.push(e.Flags.on = true, e.Flags.on ||= false, e.Flags.on &&= false, e.Flags.on &&= true, e.Flags.on ??= true);
        if (e.Shield) {
            trace.push(e.Shield.up = false, e.Shield.up ||= true, e.Shield.up ||= false);
        }
    });
    return trace;
}
`,
    expected: [true, true, false, false, false, true, true, false, false, false, false, true, true],
  },
  {
    name: "presence tests and comparisons with undefined and null, negated forms included",
    source: `export function scenario(): unknown {
    const { storage } = guarded();
    const trace: unknown[] = [];
    each(storage, (e) => {
        trace.push(e.Shield ? 1 : 0, !e.Shield, e.Shield === undefined, e.Shield !== undefined, e.Shield == null);
        trace.push(e.Shield != null, e.Shield === null, e.Shield !== null, !(e.Shield === undefined));
        trace.push(e.Position === undefined, e.Position != null, !e.Position, e.Position ? 1 : 0);
        if (e.Shield && e.Shield.hp > 0) {
            trace.push("guarded");
        }
        if (!e.Boost || e.Stunned) {
            trace.push("tags");
        }
        let spins = 0;
        while (e.Shield && spins < 1) {
            spins += 1;
        }
        trace.push(spins);
    });
    return trace;
}
`,
    expected: [
      0,
      true,
      true,
      false,
      true,
      false,
      false,
      true,
      false,
      false,
      true,
      false,
      1,
      "tags",
      0,
      1,
      false,
      false,
      true,
      false,
      true,
      false,
      true,
      true,
      false,
      true,
      false,
      1,
      "guarded",
      "tags",
      1,
    ],
  },
  {
    name: "comparisons with null and undefined on the left, through the slot and through an alias",
    source: `export function scenario(): unknown {
    const { storage } = guarded();
    const trace: unknown[] = [];
    each(storage, (e) => {
        const shield = e.Shield;
        trace.push(null === e.Shield, undefined !== e.Shield, null == e.Shield);
        trace.push(null === shield, undefined !== shield, null == shield);
    });
    return trace;
}
`,
    expected: [false, false, true, false, false, true, false, true, false, false, true, false],
  },
  {
    name: "a slot coalesced in a test reads the right-hand side only when the slot is disabled",
    source: `export function scenario(): unknown {
    const { storage } = guarded();
    const trace: unknown[] = [];
    each(storage, (e) => {
        let fallbacks = 0;
        if (e.Shield ?? ((fallbacks += 1), false)) {
            trace.push("shield");
        }
        if (e.Position ?? ((fallbacks += 10), false)) {
            trace.push("position");
        }
        trace.push(fallbacks);
    });
    return trace;
}
`,
    expected: ["position", 1, "shield", "position", 0],
  },
  {
    name: "an optional chain reads the field of an enabled slot and undefined otherwise",
    source: `export function scenario(): unknown {
    const { storage } = guarded();
    const trace: unknown[] = [];
    each(storage, (e) => {
        trace.push(e.Shield?.hp, e.Shield?.up, e.Position?.x);
    });
    return trace;
}
`,
    expected: [null, null, 2, 5, true, 1],
  },
  {
    name: "required and optional tags read as true, and a disabled optional tag as undefined",
    source: `export function scenario(): unknown {
    const { storage } = guarded();
    const trace: unknown[] = [];
    each(storage, (e) => {
        const boost = e.Boost;
        trace.push(e.Stunned, e.Boost, e.Boost === true, boost ?? "none");
    });
    return trace;
}
`,
    expected: [true, null, false, "none", true, true, true, true],
  },
  {
    name: "the data fields of required and optional relation slots read and write their columns",
    source: `export function scenario(): unknown {
    const world = createWorld();
    const anchor = spawn(register(world, Mover), { Position: { x: 0, y: 0 } });
    const tethered = register(world, Tethered);
    const ids = [
        spawn(tethered, { Tether: { target: anchor, slack: 2 }, Leash: { target: anchor, length: 4 } }),
        spawn(tethered, { Tether: { target: anchor, slack: 5 } }),
    ];
    const trace: unknown[] = [];
    each(tethered, (e) => {
        e.Tether.slack += 1;
        trace.push(e.Tether.slack, e.Leash?.length);
        if (e.Leash) {
            e.Leash.length *= 2;
        }
    });
    return { trace, slack: ids.map((id) => get(tethered, id, Tether.slack)), length: get(tethered, ids[0]!, Leash.length) };
}
`,
    expected: { trace: [6, null, 3, 4], slack: [3, 6], length: 8 },
  },
  {
    name: "an alias tests presence once, so its fields reach the column after a later disable",
    source: `export function scenario(): unknown {
    const { storage, ids } = guarded();
    const trace: unknown[] = [];
    each(storage, (e) => {
        const shield = e.Shield;
        const position = e.Position!;
        position.x = position.x + 1;
        trace.push(shield?.hp);
        if (shield) {
            disable(storage, e.id, Shield);
            shield.hp += 1;
            shield.up = false;
            trace.push(shield.hp, shield.up, shield === undefined, shield == null, e.Shield === undefined, position.x);
        } else {
            trace.push("disabled", shield === undefined, !shield);
        }
    });
    enable(storage, ids[0]!, Shield);
    return { trace, hp: get(storage, ids[0]!, Shield.hp), xs: ids.map((id) => get(storage, id, Position.x)) };
}
`,
    expected: {
      trace: [null, "disabled", true, true, 5, 6, false, false, false, true, 2],
      hp: 6,
      xs: [2, 3],
    },
  },
  {
    name: "a non-null alias of a disabled slot throws at the field read",
    source: `export function scenario(): unknown {
    const { storage } = guarded();
    const trace: unknown[] = [];
    each(storage, (e) => {
        const held = e.Shield!;
        try {
            trace.push(held.hp);
        } catch (error) {
            trace.push(error instanceof TypeError);
        }
    });
    return trace;
}
`,
    expected: [true, 5],
  },
  {
    name: "a component named by a string key reads, writes, tests, aliases, and destructures like a named one",
    source: `${PAIRS}    each(pairs, (e) => {
        e["A,B"].n += e["Position"].x;
        e["A,B"]!.n *= 2;
        trace.push(e["A,B"].n++, e["A,B"]?.n, e["A,B"] ? "present" : "absent", e["A,B"] === undefined);
        const pair = e["A,B"];
        pair.n -= 1;
        const { "A,B": slot, "A,B": { n } } = e;
        trace.push(slot.n, n);
    });
    return { trace, ns: ids.map((id) => get(pairs, id, Pair.n)) };
}
`,
    expected: {
      trace: [14, 15, "present", false, 14, 14, 6, 7, "present", false, 6, 6],
      ns: [6, 14],
    },
  },
  {
    name: "a parameter pattern destructures a component named by a string key",
    source: `${PAIRS}    each(pairs, ({ "A,B": { n }, Position: { x } }) => trace.push(n + x));
    return trace;
}
`,
    expected: [7, 3],
  },
  {
    name: "a class decorator reads the view where the class is evaluated",
    source: `${THREE_MOVERS}    const trace: unknown[] = [];
    const note = (value: unknown) => (_target: unknown, _context: ClassDecoratorContext): void => {
        trace.push(value);
    };
    each(movers, (e) => {
        @note(e.Position.x)
        class Probe {}
        trace.push(Probe.name);
    });
    return trace;
}
`,
    expected: [3, "Probe", 2, "Probe", 1, "Probe"],
  },
  {
    name: "a class static block reads and writes the view where the class is evaluated",
    source: `${THREE_MOVERS}    const trace: unknown[] = [];
    each(movers, (e) => {
        class Probe {
            static {
                e.Position.x *= 10;
                trace.push(e.Position.x);
            }
        }
        trace.push(Probe.name);
    });
    return trace;
}
`,
    expected: [30, "Probe", 20, "Probe", 10, "Probe"],
  },
  {
    name: "a class static field initializer reads the view where the class is evaluated",
    source: `${THREE_MOVERS}    const trace: unknown[] = [];
    each(movers, (e) => {
        class Probe {
            static x = e.Position.x + 1;
        }
        trace.push(Probe.x);
    });
    return trace;
}
`,
    expected: [4, 3, 2],
  },
];

/**
 * Scenarios whose field writes grow the storage in their right-hand side, or after a direct
 * growth, and report the columns.
 */
const GROWTH_CASES: readonly RunCase[] = [
  {
    name: "an assignment whose right-hand side grows the storage",
    source: `${GROWING_MOVERS}    each(movers, (e) => {
        e.Position.x = grow(e.Position.x * 10);
    });
    return { ${XS} };
}
`,
    expected: { xs: [10, 20] },
  },
  {
    name: "a compound assignment whose right-hand side grows the storage",
    source: `${GROWING_MOVERS}    each(movers, (e) => {
        e.Position.x += grow(5);
    });
    return { ${XS} };
}
`,
    expected: { xs: [6, 7] },
  },
  {
    name: "logical assignments whose right-hand side grows the storage",
    source: `${GROWING_MOVERS}    each(movers, (e) => {
        e.Position.x &&= grow(e.Position.x * 3);
        e.Velocity.dx ||= grow(e.Position.x + 4);
    });
    return { ${XS}, dxs: column((id) => get(movers, id, Velocity.dx)) };
}
`,
    expected: { xs: [3, 6], dxs: [7, 10] },
  },
  {
    name: "updates after the body grows the storage",
    source: `${GROWING_MOVERS}    let total = 0;
    each(movers, (e) => {
        grow(0);
        e.Position.x++;
        ++e.Position.y;
        total += e.Velocity.dy--;
    });
    const ys = column((id) => get(movers, id, Position.y));
    const dys = column((id) => get(movers, id, Velocity.dy));
    return { ${XS}, ys, dys, total };
}
`,
    expected: { xs: [2, 3], ys: [1, 1], dys: [2, 2], total: 6 },
  },
  {
    name: "a nullish assignment to a plain field whose right-hand side grows the storage",
    source: `export function scenario(): unknown {
    const pinned = register(createWorld(), Pinned);
    const ids = [spawn(pinned, { Mark: {} }), spawn(pinned, { Mark: {} })];
    let calls = 0;
    each(pinned, (e) => {
        e.Mark.first ??= (spawnMany(pinned, 20), ++calls);
    });
    return ids.map((id) => get(pinned, id, Mark.first));
}
`,
    expected: [2, 1],
  },
  {
    name: "optional and boolean writes whose right-hand side grows the storage",
    source: `export function scenario(): unknown {
    const { storage, ids } = guarded();
    const grow = (value: number): number => {
        spawnMany(storage, 20);
        return value;
    };
    each(storage, (e) => {
        if (e.Shield) {
            e.Shield.hp += grow(1);
        }
        e.Flags.on ||= grow(1) > 0;
    });
    return {
        hps: ids.map((id) => (has(storage, id, Shield) ? get(storage, id, Shield.hp) : -1)),
        ons: ids.map((id) => get(storage, id, Flags.on)),
    };
}
`,
    expected: { hps: [6, -1], ons: [true, true] },
  },
  {
    name: "an optional write whose right-hand side disables the component and grows the storage",
    source: `export function scenario(): unknown {
    const { storage, ids } = guarded();
    each(storage, (e) => {
        if (e.Shield) {
            e.Shield.hp = (disable(storage, e.id, Shield), spawnMany(storage, 20), 9);
        }
    });
    return ids.map((id) => has(storage, id, Shield));
}
`,
    expected: [false, false],
  },
];

describe("EmitFile", () => {
  describe("inline", () => {
    it.each(VIEW_CASES)(
      "lowers view references as the runtime evaluates them: $name",
      async ({ source, expected }) => {
        const results = await project.runEverySetting(source);

        expect(results).toStrictEqual(everyRun(expected));
      },
      RUN_TIMEOUT_MS,
    );

    it.each(GROWTH_CASES)(
      "leaves the columns the runtime leaves in realloc-safe mode: $name",
      async ({ source, expected }) => {
        const results = await project.runEverySetting(source, ["realloc-safe"]);

        expect(results).toStrictEqual(everyRun(expected, ["realloc-safe"]));
      },
      RUN_TIMEOUT_MS,
    );
  });
});
