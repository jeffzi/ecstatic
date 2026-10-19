package emit_test

import (
	"slices"
	"testing"

	"github.com/jeffzi/ecstatic/optimizer/internal/plan"
)

// fieldFormCases holds scenarios whose body reads and writes required and enabled optional fields with every form.
func fieldFormCases() []runCase {
	return []runCase{
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
			want: `{"trace":[24,26,8,6,26,22,24,8,6,24],"xs":[24,26]}`,
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
			want: `{"trace":["disabled",11,11,46,11],"hp":11,"level":46}`,
		},
	}
}

// disabledFieldCases holds scenarios whose body reads and writes a field of a disabled optional.
func disabledFieldCases() []runCase {
	return []runCase{
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
			want: `["read",true,"write",true,"compound",true,"update",true,5]`,
		},
	}
}

// disablingCallbackCases holds scenarios whose body disables the optional whose fields it reads and writes.
func disablingCallbackCases() []runCase {
	return []runCase{
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
			want: `[5,true]`,
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
			want: `{"trace":[true,true],"hp":8,"up":true}`,
		},
	}
}

// disabledWriteCases holds scenarios whose body writes a field of an optional it disabled earlier.
func disabledWriteCases() []runCase {
	return []runCase{
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
			want: `{"trace":["write",true,"compound",true],"shielded":[false,false]}`,
		},
	}
}

// bodyClassCases holds scenarios whose body declares a class whose evaluation code reads the view, once per row.
func bodyClassCases() []runCase {
	return []runCase{
		{
			name: "a class decorator reads the view where the class is evaluated",
			source: threeMovers + `    const trace: unknown[] = [];
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
			want: `[3,"Probe",2,"Probe",1,"Probe"]`,
		},
		{
			name: "a class static block reads and writes the view where the class is evaluated",
			source: threeMovers + `    const trace: unknown[] = [];
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
			want: `[30,"Probe",20,"Probe",10,"Probe"]`,
		},
		{
			name: "a class static field initializer reads the view where the class is evaluated",
			source: threeMovers + `    const trace: unknown[] = [];
    each(movers, (e) => {
        class Probe {
            static x = e.Position.x + 1;
        }
        trace.push(Probe.x);
    });
    return trace;
}
`,
			want: `[4,3,2]`,
		},
	}
}

// booleanCases holds scenarios over boolean fields, which the columns store as 1 and 0.
func booleanCases() []runCase {
	return []runCase{
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
			want: `{"trace":[false,true,true,false,true,false],"on":[false,true],"up":false}`,
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
			want: `[true,true,false,false,false,true,true,false,false,false,false,true,true]`,
		},
	}
}

// slotTestCases holds scenarios over slots in tests and comparisons.
func slotTestCases() []runCase {
	return []runCase{
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
			want: `[0,true,true,false,true,false,false,true,false,false,true,false,1,"tags",0,1,false,false,true,false,true,false,true,true,false,true,false,1,"guarded","tags",1]`,
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
			want: `["position",1,"shield","position",0]`,
		},
	}
}

// slotReadCases holds scenarios that read slots through optional chains, as tag values, and as relation data.
func slotReadCases() []runCase {
	return []runCase{
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
			want: `[null,null,2,5,true,1]`,
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
			want: `[true,null,false,"none",true,true,true,true]`,
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
			want: `{"trace":[6,null,3,4],"slack":[3,6],"length":8}`,
		},
	}
}

// aliasCases holds scenarios that hold a slot in a const.
func aliasCases() []runCase {
	return []runCase{
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
			want: `{"trace":[null,"disabled",true,true,5,6,false,false,false,true,2],"hp":6,"xs":[2,3]}`,
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
			want: `[true,5]`,
		},
	}
}

// pairs opens a scenario over a Paired storage of two rows whose "A,B".n is 1, then 3, and Position.x 2, then 4.
const pairs = `export function scenario(): unknown {
    const pairs = register(createWorld(), Paired);
    const ids = [
        spawn(pairs, { "A,B": { n: 1 }, Position: { x: 2, y: 0 } }),
        spawn(pairs, { "A,B": { n: 3 }, Position: { x: 4, y: 0 } }),
    ];
    const trace: unknown[] = [];
`

// componentKeyCases holds scenarios that reach a component by a string key, the only way to name one whose name is
// not an identifier.
func componentKeyCases() []runCase {
	return []runCase{
		{
			name: "a component named by a string key reads, writes, tests, aliases, and destructures like a named one",
			source: pairs + `    each(pairs, (e) => {
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
			want: `{"trace":[14,15,"present",false,14,14,6,7,"present",false,6,6],"ns":[6,14]}`,
		},
		{
			name: "a parameter pattern destructures a component named by a string key",
			source: pairs + `    each(pairs, ({ "A,B": { n }, Position: { x } }) => trace.push(n + x));
    return trace;
}
`,
			want: `[7,3]`,
		},
	}
}

// viewCases holds scenarios over every view reference the rewrite lowers.
func viewCases() []runCase {
	return slices.Concat(fieldFormCases(), disabledFieldCases(), disablingCallbackCases(), disabledWriteCases(), booleanCases(), slotTestCases(),
		slotReadCases(), aliasCases(), componentKeyCases(), bodyClassCases())
}

func TestFile_Inline_LowersViewReferencesAsTheRuntimeDoes(t *testing.T) {
	t.Parallel()

	checkScenarios(t, viewCases(), []bool{false, true})
}

// growingMovers opens a scenario over two movers whose grow spawns past the storage's capacity, then returns value.
const growingMovers = `export function scenario(): unknown {
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
`

// growingMoverWriteCases holds scenarios whose field writes over movers grow the storage in their right-hand side,
// or after a direct growth, and report the columns.
func growingMoverWriteCases() []runCase {
	xs := "xs: column((id) => get(movers, id, Position.x))"
	return []runCase{
		{name: "an assignment whose right-hand side grows the storage", source: growingMovers + `    each(movers, (e) => {
        e.Position.x = grow(e.Position.x * 10);
    });
    return { ` + xs + ` };
}
`, want: `{"xs":[10,20]}`},
		{name: "a compound assignment whose right-hand side grows the storage", source: growingMovers + `    each(movers, (e) => {
        e.Position.x += grow(5);
    });
    return { ` + xs + ` };
}
`, want: `{"xs":[6,7]}`},
		{name: "logical assignments whose right-hand side grows the storage", source: growingMovers + `    each(movers, (e) => {
        e.Position.x &&= grow(e.Position.x * 3);
        e.Velocity.dx ||= grow(e.Position.x + 4);
    });
    return { ` + xs + `, dxs: column((id) => get(movers, id, Velocity.dx)) };
}
`, want: `{"xs":[3,6],"dxs":[7,10]}`},
		{name: "updates after the body grows the storage", source: growingMovers + `    let total = 0;
    each(movers, (e) => {
        grow(0);
        e.Position.x++;
        ++e.Position.y;
        total += e.Velocity.dy--;
    });
    const ys = column((id) => get(movers, id, Position.y));
    const dys = column((id) => get(movers, id, Velocity.dy));
    return { ` + xs + `, ys, dys, total };
}
`, want: `{"xs":[2,3],"ys":[1,1],"dys":[2,2],"total":6}`},
	}
}

// growingOptionalWriteCases holds scenarios whose writes to plain, optional, and boolean fields grow the storage in
// their right-hand side.
func growingOptionalWriteCases() []runCase {
	return []runCase{
		{name: "a nullish assignment to a plain field whose right-hand side grows the storage", source: `export function scenario(): unknown {
    const pinned = register(createWorld(), Pinned);
    const ids = [spawn(pinned, { Mark: {} }), spawn(pinned, { Mark: {} })];
    let calls = 0;
    each(pinned, (e) => {
        e.Mark.first ??= (spawnMany(pinned, 20), ++calls);
    });
    return ids.map((id) => get(pinned, id, Mark.first));
}
`, want: `[2,1]`},
		{name: "optional and boolean writes whose right-hand side grows the storage", source: `export function scenario(): unknown {
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
`, want: `{"hps":[6,-1],"ons":[true,true]}`},
		{name: "an optional write whose right-hand side disables the component and grows the storage", source: `export function scenario(): unknown {
    const { storage, ids } = guarded();
    each(storage, (e) => {
        if (e.Shield) {
            e.Shield.hp = (disable(storage, e.id, Shield), spawnMany(storage, 20), 9);
        }
    });
    return ids.map((id) => has(storage, id, Shield));
}
`, want: `[false,false]`},
	}
}

func TestFile_Inline_WhenAFieldWriteGrowsTheStorage_LeavesTheColumnsTheRuntimeLeaves(t *testing.T) {
	t.Parallel()
	modes := []namedMode{{name: "realloc-safe", mode: plan.ModeReallocSafe}}

	checkScenariosIn(t, slices.Concat(growingMoverWriteCases(), growingOptionalWriteCases()), modes, []bool{false, true})
}

// bodyPatternCases holds scenarios whose body destructures the view or a slot in a const or let declaration.
func bodyPatternCases() []runCase {
	return []runCase{
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
			want: `{"trace":[5,6,107,5,107,1,2,103,1,103],"xs":[103,107]}`,
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
			want: `{"trace":[1,12,false,true,null,0,11,true,true,true],"xs":[11,12]}`,
		},
	}
}

// disabledPatternCases holds scenarios whose body destructures a disabled optional slot.
func disabledPatternCases() []runCase {
	return []runCase{
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
			want: `["fields",true,"empty",true,5,true,2,"empty"]`,
		},
	}
}

// fieldDefaultCases holds scenarios whose patterns give fields defaults.
func fieldDefaultCases() []runCase {
	return []runCase{
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
			want: `[2,1,"first default",1,9]`,
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
			want: `[3,4,true]`,
		},
	}
}

// parameterPatternCases holds scenarios whose callback destructures the view in its parameter.
func parameterPatternCases() []runCase {
	return []runCase{
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
			want: `{"trace":[1,12,0,16,0,4,0,8],"xs":[4,12]}`,
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
			want: `{"xs":[3,7],"dxs":[0,0]}`,
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
			want: `[101,100,200,6,5,200]`,
		},
	}
}

// disabledParameterCases holds scenarios whose parameter pattern destructures a disabled optional slot.
func disabledParameterCases() []runCase {
	return []runCase{
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
			want: `[true]`,
		},
	}
}

// parameterSlotCases holds scenarios whose parameter pattern reaches tags, optionals, relations, and field values.
func parameterSlotCases() []runCase {
	return []runCase{
		{
			name: "an expression-bodied callback destructures tags, an optional alias, and depth-one reads",
			source: `export function scenario(): unknown {
    const { storage } = guarded();
    const trace: unknown[] = [];
    each(storage, ({ Stunned, Boost, Shield, Position: { x }, Flags: { on } }) => trace.push(Stunned, Boost, Shield?.hp, Shield === undefined, x, on));
    return trace;
}
`,
			want: `[true,null,null,true,2,false,true,true,5,false,1,true]`,
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
			want: `[[2,3],[1,2]]`,
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
			want: `[5,null,2,4]`,
		},
	}
}

func TestFile_Inline_LowersDestructuringAsTheRuntimeDoes(t *testing.T) {
	t.Parallel()
	cases := slices.Concat(bodyPatternCases(), disabledPatternCases(), fieldDefaultCases(), parameterPatternCases(), disabledParameterCases(),
		parameterSlotCases())

	checkScenarios(t, cases, []bool{false, true})
}
