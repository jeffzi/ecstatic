package analysis_test

import (
	"slices"
	"testing"

	"github.com/google/go-cmp/cmp"
	"github.com/google/go-cmp/cmp/cmpopts"
)

// hazardPrelude follows casePrelude in every hazard case file: the ops, values, and storages the cases use.
const hazardPrelude = `declare global {
	interface Disposable {}
}
import {
	alive,
	countSources,
	despawn,
	despawnMany,
	destroyWorld,
	disable,
	disableMany,
	enable,
	enableMany,
	get,
	getResource,
	getSources,
	getTarget,
	has,
	hasAny,
	hasSources,
	link,
	resetResource,
	resource,
	set,
	setResource,
	spawn,
	spawnMany,
	unlink,
} from "../../src/index.js";
import { ChildOf, Shield, Stunned } from "../components.js";

declare function tag(strings: TemplateStringsArray): string;
declare function dec(value: unknown, context: unknown): void;
declare function make(): number;
declare const wide: Storage;
declare const maybe: object | undefined;
declare const loose: any;
class Stamp {
	at = 0;
}
class Box {
	get size(): number {
		return 1;
	}
	set size(value: number) {}
}
const box = new Box();
const plain = { size: 1 };
const visited: number[] = [];
const table = new Map<string, number>();
const stamp = new Stamp();
const Score = resource("Score", { value: 0, nested: { deep: { n: 0 } }, list: [0], table, stamp });
const world = createWorld();
let total = 0;
const enemies = register(createWorld(), Enemy);
const ships = register(createWorld(), Ship);
const hulls = register(createWorld(), Hull);
`

// hazardCase is a module whose first top-level each call's callback has a hazard point at each mark, the source
// text whose first occurrence in source starts it.
type hazardCase struct {
	name   string
	source string
	marks  []string
}

// hazardFreeCases hold bodies whose every evaluated node is on the allowlist.
func hazardFreeCases() []hazardCase {
	return []hazardCase{
		{name: "operators on primitive view fields and locals", source: `each(enemies, (e) => {
	e.Position.x += e.Velocity.dx * 2;
	const id = e.id;
	if (e.Position.x > 0 && !e.Velocity.dy) {
		e.Position.y = -e.Position.y;
	}
	total += id > 0 ? 1 : 0;
});`},
		{name: "global Math methods", source: `each(enemies, (e) => {
	e.Position.x = Math.max(e.Position.x, Math.abs(e.Velocity.dx));
});`},
		{name: "non-growing ecstatic ops with data-only arguments", source: `each(enemies, (e) => {
	if (has(enemies, e.id, Shield)) {
		disable(enemies, e.id, Shield);
	}
	enable(enemies, e.id, Shield, { hp: get(enemies, e.id, Position.x) });
	set(enemies, e.id, Position, { x: 1 });
	despawn(enemies, e.id);
});`},
		{name: "spawn into a storage of another shape", source: `each(enemies, () => {
	spawn(ships, { Position: { x: 1 } });
	spawnMany(ships, 2);
});`},
		{name: "class whose evaluated parts are hazard-free", source: `each(enemies, () => {
	class Local {
		static count = 0;
		static {
			Local.count = 1;
		}
		["key"] = make();
		method(): void {
			visited.push(make());
		}
	}
	total += Local.count;
});`},
		{name: "destructuring defaults that are literals", source: `each(enemies, ({ Position: { x = 0 } }) => {
	const { size = 2 } = plain;
	total += x + size;
});`},
		{name: "functions created but not called", source: `each(enemies, (e) => {
	const later = () => visited.push(e.id);
	function never(): Date {
		return new Date();
	}
	const holder = { get value(): number { return make(); }, later, never };
});`},
		{name: "operators that never convert an object", source: `each(enemies, () => {
	const held = maybe ?? plain;
	const same = held === plain || !held;
	total += same && typeof held === "object" ? 1 : 0;
});`},
	}
}

// presenceAndOpCases hold bodies whose presence tests, wrapped and string-keyed view uses, primitive keys, and
// remaining non-growing ops are hazard-free.
func presenceAndOpCases() []hazardCase {
	return []hazardCase{
		{name: "view uses through parentheses, non-null assertions, and string keys on an any-typed view", source: `each(enemies, (e: any) => {
	total = (e).Position.x;
	total = (e.Position).x;
	total = (e).id;
	total = e["Position"].x;
	total = e.Position.x;
	total = e.Position!.x;
	total = e.id;
});`},
		{name: "the other non-growing ecstatic ops with data-only arguments", source: `each(enemies, (e) => {
	total += hasAny(enemies, e.id, [Shield, Stunned]) ? 1 : 0;
	total += alive(enemies, e.id) ? 1 : 0;
	enableMany(enemies, [e.id], { Stunned: true });
	enable(enemies, e.id, { Shield: { hp: 1 }, Stunned: true });
	disableMany(enemies, [e.id], [Shield]);
	const target = getTarget(world, e.id, ChildOf);
	unlink(world, e.id, ChildOf);
	link(world, e.id, ChildOf, e.id, { order: 1 });
	total += getResource(world, Score).value;
	setResource(world, Score, { value: 1, nested: { deep: { n: 2 } } });
	resetResource(world, Score);
	total += getSources(world, ChildOf, e.id).length + countSources(world, ChildOf, e.id);
	total += hasSources(world, ChildOf, e.id) ? 1 : 0;
	despawnMany(enemies, [e.id]);
});`},
		{name: "lowered presence tests and comparisons of slots with undefined and null", source: `each(enemies, (e) => {
	if (e.Shield == null) total += 1;
	if (e.Shield != null && e.Shield !== undefined) total += 2;
	if (e.Shield === undefined || e.Position == undefined) total += 3;
	if (!e.Shield || e.Shield === null || e.Position !== null) total += 4;
	total += e.Shield ?? total > 0 ? 1 : 0;
	while (e.Shield) disable(enemies, e.id, Shield);
});`},
		{name: "element access and computed keys with primitive keys", source: `each(enemies, () => {
	total += visited[0] ?? 0;
	const keyed = { ["size"]: visited[total] };
	total += keyed.size ?? 0;
});`},
	}
}

// callHazardCases hold bodies whose calls are hazard points.
func callHazardCases() []hazardCase {
	return []hazardCase{
		{
			name: "calls of user functions",
			source: `each(enemies, (e) => {
	visited.push(e.id);
	total += make();
});`,
			marks: []string{"visited.push(e.id)", "make()"},
		},
		{
			name: "Math shadowed by a local",
			source: `const Math = { max: (a: number, b: number): number => a + b };
each(enemies, () => {
	total = Math.max(1, 2);
});`,
			marks: []string{"Math.max(1, 2)"},
		},
		{
			name: "spawn into the iterated shape or an unresolved one",
			source: `each(ships, () => {
	spawn(hulls);
	spawnMany(ships, 2);
	spawn(wide);
});`,
			marks: []string{"spawn(hulls)", "spawnMany(ships, 2)", "spawn(wide)"},
		},
		{
			name: "ecstatic ops outside the allowlist",
			source: `each(enemies, () => {
	register(createWorld(), Ship);
	each(ships, () => {});
});`,
			marks: []string{"register(createWorld(), Ship)", "createWorld(), Ship", "each(ships"},
		},
		{
			name: "ops whose object argument runs a getter at the depth they read it",
			source: `each(enemies, (e) => {
	set(enemies, e.id, Position, { get x() { return 1; } });
	spawn(ships, { Position: { get x() { return 2; } } });
});`,
			marks: []string{"set(enemies", "spawn(ships"},
		},
	}
}

// opArgumentHazardCases hold bodies whose enable, setResource, and destroyWorld calls are hazard points.
func opArgumentHazardCases() []hazardCase {
	return []hazardCase{
		{
			name: "enable whose values or record form run a getter at the depth it reads them",
			source: `each(enemies, (e) => {
	enable(enemies, e.id, Shield, { get hp() { return 1; } });
	enable(enemies, e.id, { Shield: { get hp() { return 2; } } });
});`,
			marks: []string{"enable(enemies, e.id, Shield", "enable(enemies, e.id, {"},
		},
		{
			name: "setResource whose value runs user code at any depth",
			source: `each(enemies, () => {
	setResource(world, Score, { nested: { deep: { get n() { return 1; } } } });
	setResource(world, Score, { list: visited });
	setResource(world, Score, { table });
	setResource(world, Score, { stamp });
});`,
			marks: []string{
				"setResource(world, Score, { nested", "setResource(world, Score, { list", "setResource(world, Score, { table",
				"setResource(world, Score, { stamp",
			},
		},
		{
			name:   "destroying a world",
			source: "each(enemies, () => {\n\tdestroyWorld(world);\n});",
			marks:  []string{"destroyWorld(world)"},
		},
	}
}

// syntaxHazardCases hold bodies whose constructs run user code without a call node of their own.
func syntaxHazardCases() []hazardCase {
	return []hazardCase{
		{
			name: "construction, iteration, spread, and type tests",
			source: `each(enemies, () => {
	const made = new Box();
	const text = tag` + "`x`" + `;
	for (const v of visited) total += v;
	const copy = [...visited];
	const merged = { ...plain };
	const [first] = visited;
	let second: number | undefined = 0;
	[second] = visited;
	const isBox = made instanceof Box;
	const hasSize = "size" in plain;
});`,
			marks: []string{
				"new Box()", "tag`x`", "for (const v of", "...visited", "...plain", "[first]", "[second] =", "made instanceof",
				`"size" in`,
			},
		},
		{
			name: "accessors and object operands",
			source: `each(enemies, () => {
	total = box.size;
	box.size = 2;
	const { size } = box;
	total = +plain;
	const label = ` + "`${plain}`" + `;
	total += visited[loose] ?? 0;
	const keyed = { [loose]: 1 };
});`,
			marks: []string{"box.size;", "box.size = 2", "size } = box", "+plain", "plain}`", "visited[loose]", "loose]: 1"},
		},
		{
			name: "decorators and using",
			source: `each(enemies, () => {
	@dec
	class Marked {}
	using held = null;
});`,
			marks: []string{"@dec", "using held"},
		},
	}
}

// evaluationHazardCases hold bodies whose class definitions and defaults evaluate hazard points.
func evaluationHazardCases() []hazardCase {
	return []hazardCase{
		{
			name: "class evaluation code",
			source: `each(enemies, () => {
	class Counted {
		static made = make();
		static {
			visited.push(1);
		}
		[String(total)](): void {
			visited.push(2);
		}
	}
});`,
			marks: []string{"make();", "visited.push(1)", "String(total)"},
		},
		{
			name: "defaults that call",
			source: `each(enemies, ({ Position: { x = make() } }) => {
	const { size = make() } = plain;
	total += x + size;
});`,
			marks: []string{"make() } })", "make() } ="},
		},
	}
}

func TestAnalyze_RecordsTheHazardPointsOfTheCallbackByTheAllowlist(t *testing.T) {
	t.Parallel()
	cases := slices.Concat(
		hazardFreeCases(), presenceAndOpCases(), callHazardCases(), opArgumentHazardCases(), syntaxHazardCases(),
		evaluationHazardCases(),
	)
	program := caseProject(t, hazardPrelude, valuesOf(cases, func(c hazardCase) string { return c.source }))
	runCases(t, cases, func(c hazardCase) string { return c.name }, func(t *testing.T, i int, tt hazardCase) {
		want := markOffsets(t, tt.source, caseStart(hazardPrelude), tt.marks)

		sites, table := program.analyze(t, caseFile(i))

		cb := firstEachSite(t, sites).Callback
		if cb == nil {
			t.Fatalf("Analyze(%s) callback = nil, want one", tt.name)
		}
		got := nodeOffsets(t, table, program.file(t, caseFile(i)), cb.Hazards)
		if diff := cmp.Diff(want, got, cmpopts.EquateEmpty()); diff != "" {
			t.Errorf("Analyze(%s) hazard offsets mismatch (-want +got):\n%s", tt.name, diff)
		}
	})
}
