package analysis_test

import (
	"slices"
	"testing"

	"github.com/google/go-cmp/cmp"
	"github.com/google/go-cmp/cmp/cmpopts"
	"github.com/microsoft/typescript-go/shim/ast"

	"github.com/jeffzi/ecstatic/optimizer/internal/facts"
	"github.com/jeffzi/ecstatic/optimizer/internal/nodes"
	"github.com/jeffzi/ecstatic/optimizer/internal/position"
)

const callbackHeader = `import { each, query } from "ecstatic";
declare const s: any;
`

// callbackRun is the first site of app/main.ts, with what is needed to locate its node IDs.
type callbackRun struct {
	table *nodes.Table
	file  *ast.SourceFile
	site  facts.Site
}

// runCallback analyzes app/main.ts holding callbackHeader followed by body and returns its first site.
func runCallback(t *testing.T, body string) callbackRun {
	t.Helper()
	program := loadProgram(t, installedMain(callbackHeader+body))
	sites, table := program.analyze(t, mainFile)
	if len(sites) == 0 {
		t.Fatalf("Analyze(%q) sites = none, want at least one", body)
	}
	return callbackRun{table: table, file: program.file(t, mainFile), site: sites[0]}
}

// callbackForm is the syntactic form of an inline callback: every Callback field but the body summary.
type callbackForm struct {
	Params     int
	FirstParam facts.ParamForm
	Arrow      bool
	Async      bool
	Generator  bool
	ExprBody   bool
}

// formOf is the syntactic form of cb.
func formOf(cb *facts.Callback) callbackForm {
	return callbackForm{
		Params:     cb.Params,
		FirstParam: cb.FirstParam,
		Arrow:      cb.Arrow,
		Async:      cb.Async,
		Generator:  cb.Generator,
		ExprBody:   cb.ExprBody,
	}
}

// callbackFormCase is an inline callback and its syntactic form.
type callbackFormCase struct {
	name string
	body string
	want callbackForm
}

// callbackFormCases holds one inline callback per form and first-parameter shape.
func callbackFormCases() []callbackFormCase {
	ident := facts.ParamIdentifier
	other := facts.ParamOther
	return []callbackFormCase{
		{name: "arrow with an identifier parameter", body: "each(s, (e) => {});", want: callbackForm{Params: 1, FirstParam: ident, Arrow: true}},
		{name: "arrow with an expression body", body: "each(s, (e) => e);", want: callbackForm{Params: 1, FirstParam: ident, Arrow: true, ExprBody: true}},
		{name: "async arrow", body: "each(s, async (e) => {});", want: callbackForm{Params: 1, FirstParam: ident, Arrow: true, Async: true}},
		{name: "function expression", body: "each(s, function (e) {});", want: callbackForm{Params: 1, FirstParam: ident}},
		{name: "generator function expression", body: "each(s, function* (e) {});", want: callbackForm{Params: 1, FirstParam: ident, Generator: true}},
		{
			name: "async generator query callback without parameters",
			body: "query(s, [], async function* () {});",
			want: callbackForm{FirstParam: facts.ParamNone, Async: true, Generator: true},
		},
		{name: "object pattern parameter", body: "each(s, ({ id }: any) => {});", want: callbackForm{Params: 1, FirstParam: facts.ParamObjectPattern, Arrow: true}},
		{name: "identifier parameter with a default", body: "each(s, (e = 0) => {});", want: callbackForm{Params: 1, FirstParam: other, Arrow: true}},
		{name: "rest parameter", body: "each(s, (...e: number[]) => {});", want: callbackForm{Params: 1, FirstParam: other, Arrow: true}},
		{name: "array pattern parameter", body: "each(s, ([a]: any) => {});", want: callbackForm{Params: 1, FirstParam: other, Arrow: true}},
		{name: "second parameter counted", body: "each(s, (e, f = 0) => {});", want: callbackForm{Params: 2, FirstParam: ident, Arrow: true}},
		{name: "this parameter not counted", body: "each(s, function (this: unknown, e) {});", want: callbackForm{Params: 1, FirstParam: ident}},
	}
}

func TestAnalyze_RecordsInlineCallbackForm(t *testing.T) {
	t.Parallel()
	for _, tt := range callbackFormCases() {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()

			cb := runCallback(t, tt.body).site.Callback

			if cb == nil {
				t.Fatalf("Analyze(%q) callback = nil, want %+v", tt.body, tt.want)
			}
			if diff := cmp.Diff(tt.want, formOf(cb)); diff != "" {
				t.Errorf("Analyze(%q) callback form mismatch (-want +got):\n%s", tt.body, diff)
			}
		})
	}
}

// registerDecl declares the sink that case bodies pass values to.
const registerDecl = "declare function register(value: unknown): void;\n"

func TestAnalyze_RecordsNoCallbackForANonInlineLastArgument(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name string
		body string
	}{
		{name: "identifier", body: "declare const move: (e: number) => void;\neach(s, move);"},
		{name: "call result", body: "declare function makeMove(): (e: number) => void;\neach(s, makeMove());"},
		{name: "member", body: "declare const handlers: { move: (e: number) => void };\neach(s, handlers.move);"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()

			got := runCallback(t, tt.body).site.Callback

			if got != nil {
				t.Errorf("Analyze(%q) callback = %+v, want nil", tt.body, got)
			}
		})
	}
}

// wantUse is an expected view use; mark is the source text whose first occurrence starts its node.
type wantUse struct {
	comp  string
	field string
	mark  string
	kind  facts.UseKind
	alias bool
}

// viewUseAt is a recorded view use with the start offset of its node in place of its node ID.
type viewUseAt struct {
	Comp   string
	Field  string
	Offset int
	Kind   facts.UseKind
	Alias  bool
}

// recordedViewUses lists uses, view uses of a callback in file, with their node start offsets.
func recordedViewUses(t *testing.T, table *nodes.Table, file *ast.SourceFile, uses []facts.ViewUse) []viewUseAt {
	t.Helper()
	ids := make([]facts.NodeID, 0, len(uses))
	for _, use := range uses {
		ids = append(ids, use.Node)
	}
	offsets := nodeOffsets(t, table, file, ids)
	got := make([]viewUseAt, 0, len(uses))
	for i, use := range uses {
		got = append(got, viewUseAt{Comp: use.Comp, Field: use.Field, Offset: offsets[i], Kind: use.Kind, Alias: use.Alias})
	}
	return got
}

// wantedViewUses resolves the marks of want against text, which starts at offset start of its file.
func wantedViewUses(t *testing.T, text string, start int, want []wantUse) []viewUseAt {
	t.Helper()
	uses := make([]viewUseAt, 0, len(want))
	for _, use := range want {
		offset := start + position.Occurrence(t, text, use.mark, 0)
		uses = append(uses, viewUseAt{Comp: use.comp, Field: use.field, Offset: offset, Kind: use.kind, Alias: use.alias})
	}
	return uses
}

// viewUseCases holds callbacks whose view references are field reads, writes, updates, and id reads.
func viewUseCases() []struct {
	name string
	body string
	want []wantUse
} {
	return []struct {
		name string
		body string
		want []wantUse
	}{
		{
			name: "reads, assignments, updates, and id in source order",
			body: registerDecl + `each(s, (e: any) => {
	e.Position.x = e.Velocity.dx;
	e.Position.y += 1;
	e.Flags.on ||= true;
	e.Health.hp++;
	--e.Health.hp;
	register(e.id);
});`,
			want: []wantUse{
				{kind: facts.UseFieldAssign, comp: "Position", field: "x", mark: "e.Position.x ="},
				{kind: facts.UseFieldRead, comp: "Velocity", field: "dx", mark: "e.Velocity.dx"},
				{kind: facts.UseFieldAssign, comp: "Position", field: "y", mark: "e.Position.y +="},
				{kind: facts.UseFieldAssign, comp: "Flags", field: "on", mark: "e.Flags.on ||="},
				{kind: facts.UseFieldUpdate, comp: "Health", field: "hp", mark: "e.Health.hp++"},
				{kind: facts.UseFieldUpdate, comp: "Health", field: "hp", mark: "--e.Health.hp"},
				{kind: facts.UseID, mark: "e.id"},
			},
		},
		{
			name: "expression body",
			body: "each(s, (e: any) => e.Position.x);",
			want: []wantUse{{kind: facts.UseFieldRead, comp: "Position", field: "x", mark: "e.Position.x"}},
		},
		{
			name: "function expression callback",
			body: "each(s, function (e: any) { e.Position.x = 1; });",
			want: []wantUse{{kind: facts.UseFieldAssign, comp: "Position", field: "x", mark: "e.Position.x"}},
		},
		{
			name: "a local shadowing the view is not the view",
			body: `each(s, (e: any) => {
	{
		const e = { Position: { x: 1 } };
		e.Position.x = 2;
	}
});`,
		},
	}
}

func TestAnalyze_RecordsTheViewUsesOfTheCallback(t *testing.T) {
	t.Parallel()
	for _, tt := range viewUseCases() {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			want := wantedViewUses(t, callbackHeader+tt.body, 0, tt.want)

			run := runCallback(t, tt.body)

			got := recordedViewUses(t, run.table, run.file, run.site.Callback.ViewUses)
			if diff := cmp.Diff(want, got, cmpopts.EquateEmpty()); diff != "" {
				t.Errorf("Analyze(%q) view uses mismatch (-want +got):\n%s", tt.body, diff)
			}
		})
	}
}

// viewPrelude follows casePrelude in every view-reference case file: the components, values, and storages the cases
// use. Enemy holds Position and Velocity, and optionally Shield and the tag Stunned; Linked holds Position and the
// relation ChildOf; marked holds Position and the tag Stunned.
const viewPrelude = `import { Shield, Stunned } from "../components.js";

declare function visit(value: unknown): void;
const xs: number[] = [];
const enemies = register(createWorld(), Enemy);
const linked = register(createWorld(), Linked);
const marked = register(createWorld(), archetype([Position, Stunned]));
`

// loweredViewCase is a module whose first top-level each call's callback references the view only in positions that
// lower, with the view uses it records.
type loweredViewCase struct {
	name   string
	source string
	want   []wantUse
}

// slotViewCases hold callbacks that reach optional fields, test slots, and compare them.
func slotViewCases() []loweredViewCase {
	return []loweredViewCase{
		{name: "optional fields through a non-null assertion", source: `each(enemies, (e) => {
	e.Shield!.hp += e.Shield!.hp;
	e.Shield!.active = true;
});`, want: []wantUse{
			{kind: facts.UseFieldAssign, comp: "Shield", field: "hp", mark: "e.Shield!.hp +="},
			{kind: facts.UseFieldRead, comp: "Shield", field: "hp", mark: "e.Shield!.hp;"},
			{kind: facts.UseFieldAssign, comp: "Shield", field: "active", mark: "e.Shield!.active"},
		}},
		{name: "an optional chain on a slot", source: `each(enemies, (e) => {
	xs.push(e.Shield?.hp ?? 0);
});`, want: []wantUse{{kind: facts.UseOptionalRead, comp: "Shield", field: "hp", mark: "e.Shield?.hp"}}},
		{name: "slots in test positions", source: `each(enemies, (e) => {
	if (e.Shield && e.Shield.hp > 0) xs.push(1);
	while (!e.Stunned) break;
	xs.push(e.Shield ? 1 : 0);
});`, want: []wantUse{
			{kind: facts.UsePresence, comp: "Shield", mark: "e.Shield &&"},
			{kind: facts.UseFieldRead, comp: "Shield", field: "hp", mark: "e.Shield.hp"},
			{kind: facts.UsePresence, comp: "Stunned", mark: "e.Stunned)"},
			{kind: facts.UsePresence, comp: "Shield", mark: "e.Shield ?"},
		}},
		{name: "slots compared with undefined and null, either side", source: `each(enemies, (e) => {
	const a = e.Shield === undefined;
	const b = undefined !== e.Shield;
	const c = e.Shield == null || e.Position != null;
	const d = e.Shield === null;
	xs.push(+a, +b, +c, +d);
});`, want: []wantUse{
			{kind: facts.UseCompare, comp: "Shield", mark: "e.Shield === undefined"},
			{kind: facts.UseCompare, comp: "Shield", mark: "undefined !== e.Shield"},
			{kind: facts.UseCompare, comp: "Shield", mark: "e.Shield == null"},
			{kind: facts.UseCompare, comp: "Position", mark: "e.Position != null"},
			{kind: facts.UseCompare, comp: "Shield", mark: "e.Shield === null"},
		}},
		{name: "a slot coalesced in a test", source: `each(enemies, (e) => {
	if (e.Shield ?? xs.length) xs.push(1);
});`, want: []wantUse{{kind: facts.UseCoalesce, comp: "Shield", mark: "e.Shield ??"}}},
	}
}

// keyedViewCases hold callbacks that reach slots by string keys, which lower as the property names they spell.
func keyedViewCases() []loweredViewCase {
	return []loweredViewCase{
		{name: "slots reached by string keys", source: `each(enemies, (e) => {
	e["Position"].x += e["Shield"]!.hp;
	xs.push(e["Shield"]?.hp ?? 0);
	if (e["Shield"]) xs.push(1);
	const held = e["Shield"];
	if (held) held.hp = 1;
	const { "Velocity": v } = e;
	visit(v.dx);
});`, want: []wantUse{
			{kind: facts.UseFieldAssign, comp: "Position", field: "x", mark: `e["Position"].x`},
			{kind: facts.UseFieldRead, comp: "Shield", field: "hp", mark: `e["Shield"]!.hp`},
			{kind: facts.UseOptionalRead, comp: "Shield", field: "hp", mark: `e["Shield"]?.hp`},
			{kind: facts.UsePresence, comp: "Shield", mark: `e["Shield"])`},
			{kind: facts.UseAlias, comp: "Shield", mark: `held = e["Shield"]`},
			{kind: facts.UsePresence, comp: "Shield", mark: "held)", alias: true},
			{kind: facts.UseFieldAssign, comp: "Shield", field: "hp", mark: "held.hp", alias: true},
			{kind: facts.UseDestructure, mark: `{ "Velocity": v } = e`},
			{kind: facts.UseAlias, comp: "Velocity", mark: `"Velocity": v`},
			{kind: facts.UseFieldRead, comp: "Velocity", field: "dx", mark: "v.dx", alias: true},
		}},
	}
}

// tagAndAliasViewCases hold callbacks that read tag slots, relation fields, and aliases of slots.
func tagAndAliasViewCases() []loweredViewCase {
	return []loweredViewCase{
		{name: "an optional tag as a value", source: `each(enemies, (e) => {
	const stunned = e.Stunned;
	visit(stunned);
});`, want: []wantUse{{kind: facts.UseTag, comp: "Stunned", mark: "e.Stunned"}}},
		{name: "a required tag as a value", source: `each(marked, (e) => {
	visit(e.Stunned);
});`, want: []wantUse{{kind: facts.UseTag, comp: "Stunned", mark: "e.Stunned"}}},
		{name: "a relation data field", source: `each(linked, (e) => {
	e.ChildOf.order += 1;
});`, want: []wantUse{{kind: facts.UseFieldAssign, comp: "ChildOf", field: "order", mark: "e.ChildOf.order"}}},
		{name: "aliases of a slot, plain and non-null asserted", source: `each(enemies, (e) => {
	const shield = e.Shield;
	if (shield) shield.hp = 1;
	const held = e.Shield!;
	xs.push(held.hp, held === undefined ? 0 : 1, held?.hp ?? 0);
});`, want: []wantUse{
			{kind: facts.UseAlias, comp: "Shield", mark: "shield = e.Shield"},
			{kind: facts.UsePresence, comp: "Shield", mark: "shield)", alias: true},
			{kind: facts.UseFieldAssign, comp: "Shield", field: "hp", mark: "shield.hp", alias: true},
			{kind: facts.UseAlias, comp: "Shield", mark: "held = e.Shield!"},
			{kind: facts.UseFieldRead, comp: "Shield", field: "hp", mark: "held.hp", alias: true},
			{kind: facts.UseCompare, comp: "Shield", mark: "held === undefined", alias: true},
			{kind: facts.UseOptionalRead, comp: "Shield", field: "hp", mark: "held?.hp", alias: true},
		}},
	}
}

// markDecl declares the decorator factory that class cases decorate with.
const markDecl = "declare function mark(value: unknown): (target: unknown, context: unknown) => void;\n"

// classViewCases hold a class declared in the body whose decorators, computed keys, static field initializers, and
// static blocks reference the view in positions that lower.
func classViewCases() []loweredViewCase {
	return []loweredViewCase{
		{name: "class evaluation code reading the view", source: markDecl + `each(enemies, (e) => {
	@mark(e.Position.x)
	class Probe {
		[String(e.Velocity.dx)](): void {}
		static hp = e.Position.y;
		static {
			xs.push(e.id);
		}
	}
	visit(Probe);
});`, want: []wantUse{
			{kind: facts.UseFieldRead, comp: "Position", field: "x", mark: "e.Position.x)"},
			{kind: facts.UseFieldRead, comp: "Velocity", field: "dx", mark: "e.Velocity.dx"},
			{kind: facts.UseFieldRead, comp: "Position", field: "y", mark: "e.Position.y"},
			{kind: facts.UseID, mark: "e.id"},
		}},
	}
}

// viewCallback analyzes the ith case file of program and returns the callback of its first top-level each site,
// with the node table and the file.
func viewCallback(t *testing.T, program *testProgram, i int) (*facts.Callback, *nodes.Table, *ast.SourceFile) {
	t.Helper()
	sites, table := program.analyze(t, caseFile(i))
	site := firstEachSite(t, sites)
	if len(site.Shapes) != 1 || site.Callback == nil {
		t.Fatalf("Analyze(%s) shapes = %v, callback = %v, want one shape and a callback", caseFile(i), site.Shapes, site.Callback)
	}
	return site.Callback, table, program.file(t, caseFile(i))
}

func TestAnalyze_WhenEveryViewReferenceLowers_RecordsEachAsAViewUse(t *testing.T) {
	t.Parallel()
	cases := slices.Concat(slotViewCases(), keyedViewCases(), tagAndAliasViewCases(), classViewCases())
	program := caseProject(t, viewPrelude, valuesOf(cases, func(c loweredViewCase) string { return c.source }))
	runCases(t, cases, func(c loweredViewCase) string { return c.name }, func(t *testing.T, i int, tt loweredViewCase) {
		want := wantedViewUses(t, tt.source, caseStart(viewPrelude), tt.want)

		cb, table, file := viewCallback(t, program, i)

		if diff := cmp.Diff(want, recordedViewUses(t, table, file, cb.ViewUses), cmpopts.EquateEmpty()); diff != "" {
			t.Errorf("Analyze(%s) view uses mismatch (-want +got):\n%s", tt.name, diff)
		}
		if len(cb.Escapes) != 0 {
			t.Errorf("Analyze(%s) escapes = %+v, want none", tt.name, cb.Escapes)
		}
	})
}

// patternCase is a module whose first top-level each call's callback destructures the view or its slots.
type patternCase struct {
	name   string
	source string
}

// loweredPatternCases hold callbacks that destructure the view and its slots, in parameters and in const and let
// declarations, only in the forms that lower.
func loweredPatternCases() []patternCase {
	return []patternCase{
		{name: "parameter pattern with nested defaults and optional slots", source: `each(enemies, ({ id, Position: p, Velocity: { dx, dy: vy = 0 }, Shield, Stunned }) => {
	p.x += dx + vy;
	if (Shield) Shield.hp = id;
	visit(Stunned);
	const later = () => dx;
	visit(later);
});`},
		{name: "const and let patterns of the view and its slots", source: `each(enemies, (e) => {
	const { x, y: py = 1 } = e.Position;
	let { Velocity: v, id } = e;
	const { hp, label: { length } } = e.Shield!;
	const {} = e.Shield!;
	const { Position: { x: px } } = e;
	visit([x, py, v.dx, id, hp, length, px, () => x]);
});`},
		{name: "pattern of a relation field", source: `each(linked, (e) => {
	const { order, pinned } = e.ChildOf;
	visit(order + +pinned);
});`},
	}
}

func TestAnalyze_WhenEveryPatternLowers_RecordsNoEscape(t *testing.T) {
	t.Parallel()
	cases := loweredPatternCases()
	program := caseProject(t, viewPrelude, valuesOf(cases, func(c patternCase) string { return c.source }))
	runCases(t, cases, func(c patternCase) string { return c.name }, func(t *testing.T, i int, tt patternCase) {
		cb, _, _ := viewCallback(t, program, i)

		if len(cb.Escapes) != 0 {
			t.Errorf("Analyze(%s) escapes = %+v, want none", tt.name, cb.Escapes)
		}
	})
}

// wantEscape is an expected view escape; its node starts at the nth (from 0) occurrence of mark.
type wantEscape struct {
	mark string
	nth  int
	kind facts.EscapeKind
}

// escapeAt is a recorded view escape with the start offset of its node in place of its node ID.
type escapeAt struct {
	Offset int
	Kind   facts.EscapeKind
}

// escapingViewCase is a module whose first top-level each call's callback references the view in positions that do
// not lower, with the escapes it records.
type escapingViewCase struct {
	name   string
	source string
	want   []wantEscape
}

// valueEscapeCases hold callbacks that use the view or a data slot as a value, or reach keys the shape lacks.
func valueEscapeCases() []escapingViewCase {
	view, slot := facts.EscapeView, facts.EscapeSlotValue
	return []escapingViewCase{
		{name: "the view passed, stored, compared, and returned", source: `each(enemies, (e) => {
	visit(e);
	const held = e;
	if (e === held) xs.push(1);
	return e;
});`, want: []wantEscape{{mark: "e);", kind: view}, {mark: "e;", kind: view}, {mark: "e === held", kind: view}, {mark: "e;", nth: 1, kind: view}}},
		{name: "computed access on the view or a slot", source: `each(enemies, (e) => {
	visit([e[String("Position") as "Position"].x, e["id"], e["toString"], e?.["Position"].x, e.Position["x"]]);
});`, want: []wantEscape{
			{mark: `e[String`, kind: facts.EscapeComputed},
			{mark: `e["id"]`, kind: facts.EscapeComputed},
			{mark: `e["toString"]`, kind: facts.EscapeComputed},
			{mark: `e?.["Position"]`, kind: facts.EscapeComputed},
			{mark: `e.Position["x"]`, kind: facts.EscapeComputed},
		}},
		{name: "data slots used as values", source: `each(enemies, (e) => {
	const hp = e.Shield && e.Shield.hp;
	const either = e.Shield ?? xs;
	let slot = e.Position;
	visit([hp, either, slot]);
});`, want: []wantEscape{{mark: "e.Shield &&", kind: slot}, {mark: "e.Shield ??", kind: slot}, {mark: "e.Position;", kind: slot}}},
		{name: "an alias referenced as a value", source: `each(enemies, (e) => {
	const shield = e.Shield;
	visit(shield);
});`, want: []wantEscape{{mark: "shield);", kind: slot}}},
		{name: "keys outside the shape", source: `each(linked, (e: any) => {
	visit(e.toString());
	visit(e.Position.constructor);
	visit(e.ChildOf.target);
	visit(e.Velocity.dx);
});`, want: []wantEscape{
			{mark: "e.toString", kind: facts.EscapeKey},
			{mark: "e.Position.constructor", kind: facts.EscapeKey},
			{mark: "e.ChildOf.target", kind: facts.EscapeKey},
			{mark: "e.Velocity", kind: facts.EscapeKey},
		}},
	}
}

// formEscapeCases hold callbacks that assign slots, continue optional chains, nest functions, or assign through
// patterns.
func formEscapeCases() []escapingViewCase {
	return []escapingViewCase{
		{name: "slots and the id assigned", source: `each(enemies, (e: any) => {
	e.Position = { x: 1, y: 2 };
	e.id = 0;
	e.Shield++;
});`, want: []wantEscape{
			{mark: "e.Position =", kind: facts.EscapeSlotAssign},
			{mark: "e.id =", kind: facts.EscapeSlotAssign},
			{mark: "e.Shield++", kind: facts.EscapeSlotAssign},
		}},
		{name: "an optional chain continued past the field", source: `each(enemies, (e) => {
	visit(e.Shield?.label.length);
});`, want: []wantEscape{{mark: "e.Shield?.label", kind: facts.EscapeChain}}},
		{name: "references inside nested functions", source: `each(enemies, (e) => {
	const later = () => e.id;
	const shield = e.Shield;
	function read(): number {
		return shield ? shield.hp : 0;
	}
	visit([later, read]);
});`, want: []wantEscape{
			{mark: "e.id;", kind: facts.EscapeNested},
			{mark: "shield ?", kind: facts.EscapeNested},
			{mark: "shield.hp", kind: facts.EscapeNested},
		}},
		{name: "a reference inside the callback of a nested each", source: `each(enemies, (e) => {
	each(linked, () => {
		visit(e.Position.x);
	});
});`, want: []wantEscape{{mark: "e.Position.x", kind: facts.EscapeNestedLoop}}},
		{name: "fields as destructuring-assignment and for-of targets", source: `each(enemies, (e) => {
	[e.Position.x] = [1];
	({ y: e.Position.y } = { y: 1 });
	for (e.Velocity.dx of xs) visit(0);
});`, want: []wantEscape{
			{mark: "e.Position.x]", kind: facts.EscapeTarget},
			{mark: "e.Position.y }", kind: facts.EscapeTarget},
			{mark: "e.Velocity.dx of", kind: facts.EscapeTarget},
		}},
	}
}

// operationEscapeCases hold callbacks that call a field as a method or apply arithmetic that writes to a boolean
// field.
func operationEscapeCases() []escapingViewCase {
	call, arithmetic := facts.EscapeFieldCall, facts.EscapeBooleanArithmetic
	return []escapingViewCase{
		{name: "a plain field called as a method", source: `import { ref } from "../../src/index.js";

const Hook = component("Hook", { run: ref<() => number>() });
const hooked = register(createWorld(), archetype([Hook]));
each(hooked, (e) => {
	visit(e.Hook.run!());
	visit(e.Hook.run?.());
});`, want: []wantEscape{{mark: "e.Hook.run!()", kind: call}, {mark: "e.Hook.run?.()", kind: call}}},
		{name: "a number field called through a loosely typed view", source: `each(enemies, (e: any) => {
	visit(e.Position.x());
});`, want: []wantEscape{{mark: "e.Position.x()", kind: call}}},
		{name: "updates and arithmetic compound operators on a boolean field", source: `each(enemies, (e: any) => {
	e.Shield.active++;
	e.Shield.active += 1;
	e.Shield.active *= 2;
	e.Shield.active ||= false;
});`, want: []wantEscape{
			{mark: "e.Shield.active++", kind: arithmetic},
			{mark: "e.Shield.active +=", kind: arithmetic},
			{mark: "e.Shield.active *=", kind: arithmetic},
		}},
	}
}

// patternEscapeCases hold callbacks whose destructuring patterns use a form that does not lower, or whose
// pattern-bound slots escape as an alias would.
func patternEscapeCases() []escapingViewCase {
	destructure := facts.EscapeDestructure
	return []escapingViewCase{
		{name: "slots bound by a parameter pattern, used as a value and from a nested function", source: `each(enemies, ({ Position, Velocity: v }) => {
	visit(Position);
	const later = () => v.dx;
	visit(later);
});`, want: []wantEscape{{mark: "Position);", kind: facts.EscapeSlotValue}, {mark: "v.dx", kind: facts.EscapeNested}}},
		{name: "a rest element in a parameter pattern", source: `each(enemies, ({ id, ...others }) => {
	visit([id, others]);
});`, want: []wantEscape{{mark: "...others", kind: destructure}}},
		{name: "rest elements in patterns of the view and of a slot", source: `each(enemies, (e) => {
	const { id, ...others } = e;
	const { Position: { ...xy } } = e;
	visit([id, others, xy]);
});`, want: []wantEscape{{mark: "...others", kind: destructure}, {mark: "...xy", kind: destructure}}},
		{name: "computed keys in patterns of the view and of a slot", source: `each(enemies, (e) => {
	const key = "x" as const;
	const { ["Position"]: p } = e;
	const { [key]: x } = e.Position;
	visit([p, x]);
});`, want: []wantEscape{{mark: `["Position"]`, kind: facts.EscapeComputed}, {mark: "[key]", kind: facts.EscapeComputed}}},
		{name: "defaults on slots", source: `each(enemies, (e) => {
	const { Shield: s = undefined } = e;
	const { Velocity: { dx } = { dx: 0 } } = e;
	visit([s, dx]);
});`, want: []wantEscape{{mark: "Shield: s", kind: destructure}, {mark: "Velocity: {", kind: destructure}}},
		{name: "pattern keys outside the shape", source: `each(linked, (e: any) => {
	const { toString } = e;
	const { constructor: make } = e.Position;
	const { ChildOf: { target }, Velocity } = e;
	visit([toString, make, target, Velocity]);
});`, want: []wantEscape{
			{mark: "toString }", kind: facts.EscapeKey},
			{mark: "constructor: make", kind: facts.EscapeKey},
			{mark: "target }", kind: facts.EscapeKey},
			{mark: "Velocity }", kind: facts.EscapeKey},
		}},
		{name: "a var declaration destructuring a slot", source: `each(enemies, (e) => {
	var { x } = e.Position;
	visit(x);
});`, want: []wantEscape{{mark: "e.Position;", kind: destructure}}},
	}
}

// evaluationEscapeCases hold a class declared in the body whose evaluation code lets the view escape and whose
// instance members and methods reference it, and direct eval calls in the body and in a nested function.
func evaluationEscapeCases() []escapingViewCase {
	view, nested := facts.EscapeView, facts.EscapeNested
	return []escapingViewCase{
		{name: "class evaluation code and class members", source: markDecl + `each(enemies, (e) => {
	@mark(e)
	class Probe {
		[String(e)](): void {}
		static held = e;
		static {
			visit(e);
		}
		own = e.id;
		read(): number {
			return e.id;
		}
	}
	visit(Probe);
});`, want: []wantEscape{
			{mark: "e)\n\tclass", kind: view},
			{mark: "e)]", kind: view},
			{mark: "e;", kind: view},
			{mark: "e);", kind: view},
			{mark: "e.id;", kind: nested},
			{mark: "e.id;", nth: 1, kind: nested},
		}},
		{name: "direct eval in the body and in a nested function", source: `each(enemies, (e) => {
	e.Position.x = 1;
	eval("visit(e)");
	visit(() => eval("1"));
});`, want: []wantEscape{{mark: `eval("visit(e)")`, kind: facts.EscapeEval}, {mark: `eval("1")`, kind: facts.EscapeEval}}},
	}
}

func TestAnalyze_WhenAViewReferenceDoesNotLower_RecordsItsPositionAndKind(t *testing.T) {
	t.Parallel()
	cases := slices.Concat(valueEscapeCases(), formEscapeCases(), operationEscapeCases(), patternEscapeCases(), evaluationEscapeCases())
	program := caseProject(t, viewPrelude, valuesOf(cases, func(c escapingViewCase) string { return c.source }))
	runCases(t, cases, func(c escapingViewCase) string { return c.name }, func(t *testing.T, i int, tt escapingViewCase) {
		want := make([]escapeAt, 0, len(tt.want))
		for _, escape := range tt.want {
			offset := caseStart(viewPrelude) + position.Occurrence(t, tt.source, escape.mark, escape.nth)
			want = append(want, escapeAt{Offset: offset, Kind: escape.kind})
		}

		cb, table, file := viewCallback(t, program, i)

		ids := make([]facts.NodeID, 0, len(cb.Escapes))
		for _, escape := range cb.Escapes {
			ids = append(ids, escape.Node)
		}
		offsets := nodeOffsets(t, table, file, ids)
		got := make([]escapeAt, 0, len(cb.Escapes))
		for j, escape := range cb.Escapes {
			got = append(got, escapeAt{Offset: offsets[j], Kind: escape.Kind})
		}
		if diff := cmp.Diff(want, got, cmpopts.EquateEmpty()); diff != "" {
			t.Errorf("Analyze(%s) escapes mismatch (-want +got):\n%s", tt.name, diff)
		}
	})
}

// positionedEscapesSource lets the view escape once directly in the callback and once from a nested function.
const positionedEscapesSource = `each(enemies, (e) => {
	visit(e);
	visit(() => e.id);
});`

func TestAnalyze_WhenAViewReferenceDoesNotLower_RecordsThePositionOfItsNode(t *testing.T) {
	t.Parallel()
	program := caseProject(t, viewPrelude, []string{positionedEscapesSource})
	text := casePrelude + viewPrelude + positionedEscapesSource
	starts := markOffsets(t, positionedEscapesSource, caseStart(viewPrelude), []string{"e);", "e.id"})
	want := positionsIn(program.file(t, caseFile(0)).FileName(), text, starts)

	cb, _, _ := viewCallback(t, program, 0)

	got := valuesOf(cb.Escapes, func(e facts.ViewEscape) facts.Position { return e.Pos })
	if diff := cmp.Diff(want, got); diff != "" {
		t.Errorf("Analyze() escape positions mismatch (-want +got):\n%s", diff)
	}
}

// loopEscape is a recorded view escape reduced to its kind and the call of the nested loop it is recorded against.
type loopEscape struct {
	Kind facts.EscapeKind
	Loop facts.NodeID
}

// loopEscapes reduces escapes to their kinds and loops, in order.
func loopEscapes(escapes []facts.ViewEscape) []loopEscape {
	out := make([]loopEscape, 0, len(escapes))
	for _, escape := range escapes {
		out = append(out, loopEscape{Kind: escape.Kind, Loop: escape.Loop})
	}
	return out
}

// nestedLoopsSource references the views of two enclosing each calls from the callbacks of the loops nested in them.
const nestedLoopsSource = `each(enemies, (e) => {
	each(linked, (l) => {
		visit(e.Position.x);
		each(marked, () => {
			visit(e.id + l.id);
		});
	});
});`

func TestAnalyze_WhenANestedLoopCallbackReferencesAnOuterView_RecordsTheInnermostLoop(t *testing.T) {
	t.Parallel()
	program := caseProject(t, viewPrelude, []string{nestedLoopsSource})

	sites, _ := program.analyze(t, caseFile(0))

	outer := firstEachSite(t, sites)
	if len(outer.Nested) != 1 || len(outer.Nested[0].Nested) != 1 {
		t.Fatalf("Analyze() nested sites = %+v, want one each holding one each", outer.Nested)
	}
	middle, inner := outer.Nested[0], outer.Nested[0].Nested[0]
	loop := facts.EscapeNestedLoop
	wantOuter := []loopEscape{{Kind: loop, Loop: middle.Call}, {Kind: loop, Loop: inner.Call}}
	if diff := cmp.Diff(wantOuter, loopEscapes(outer.Callback.Escapes)); diff != "" {
		t.Errorf("Analyze() outer escapes mismatch (-want +got):\n%s", diff)
	}
	wantMiddle := []loopEscape{{Kind: loop, Loop: inner.Call}}
	if diff := cmp.Diff(wantMiddle, loopEscapes(middle.Callback.Escapes)); diff != "" {
		t.Errorf("Analyze() middle escapes mismatch (-want +got):\n%s", diff)
	}
}

// returnAt is a recorded return statement with the start offset of its node in place of its node ID.
type returnAt struct {
	Offset int
	Nested bool
}

// returnsBody holds returns at the body root, under a loop or switch, under a label or try, and in nested functions.
const returnsBody = `each(s, (e: any) => {
	if (e > 0) return;
	for (const k of [1]) {
		if (k) return k;
	}
	switch (e) {
		case 1:
			return;
	}
	block: {
		return 2;
	}
	try {
		return;
	} finally {
		e.done = true;
	}
	const f = () => {
		return 1;
	};
	while (e) {
		const g = function () {
			return 3;
		};
	}
	do {
		return;
	} while (e);
	for (;;) return;
	for (const k in e) return;
});`

func TestAnalyze_WhenCallbackReturnsAtEveryNesting_RecordsOnlyItsOwnReturns(t *testing.T) {
	t.Parallel()
	source := callbackHeader + returnsBody
	bare := func(n int, nested bool) returnAt {
		return returnAt{Offset: position.Occurrence(t, source, "return;", n), Nested: nested}
	}
	want := []returnAt{
		bare(0, false),
		{Offset: position.Occurrence(t, source, "return k;", 0), Nested: true},
		bare(1, true),
		{Offset: position.Occurrence(t, source, "return 2;", 0), Nested: false},
		bare(2, false),
		bare(3, true),
		bare(4, true),
		bare(5, true),
	}

	run := runCallback(t, returnsBody)

	returns := run.site.Callback.Returns
	ids := make([]facts.NodeID, 0, len(returns))
	for _, r := range returns {
		ids = append(ids, r.Node)
	}
	offsets := nodeOffsets(t, run.table, run.file, ids)
	got := make([]returnAt, 0, len(returns))
	for i, r := range returns {
		got = append(got, returnAt{Offset: offsets[i], Nested: r.Nested})
	}
	if diff := cmp.Diff(want, got); diff != "" {
		t.Errorf("Analyze() returns mismatch (-want +got):\n%s", diff)
	}
}

// markOffsets is the offset in its file of the first occurrence of each of marks in text, which starts at offset
// start of its file.
func markOffsets(t *testing.T, text string, start int, marks []string) []int {
	t.Helper()
	offsets := make([]int, 0, len(marks))
	for _, mark := range marks {
		offsets = append(offsets, start+position.Occurrence(t, text, mark, 0))
	}
	return offsets
}

// checkCallbackOffsets compares the start offsets of the nodes ids picks from body's callback with the first
// occurrences of marks in the analyzed source.
func checkCallbackOffsets(t *testing.T, body string, marks []string, ids func(*facts.Callback) []facts.NodeID) {
	t.Helper()
	want := markOffsets(t, callbackHeader+body, 0, marks)

	run := runCallback(t, body)

	cb := run.site.Callback
	if cb == nil {
		t.Fatalf("Analyze(%q) callback = nil, want one", body)
	}
	got := nodeOffsets(t, run.table, run.file, ids(cb))
	if !slices.Equal(got, want) {
		t.Errorf("Analyze(%q) offsets = %v, want %v", body, got, want)
	}
}

func TestAnalyze_WhenCallbackDeclaresVars_RecordsThoseOutsideNestedFunctions(t *testing.T) {
	t.Parallel()
	body := `each(s, (e: any) => {
	var a = 1, b;
	for (var i = 0; i < 1; i++) {}
	{
		var c;
	}
	let d = 0;
	function inner() {
		var hidden;
	}
	class Local {
		static {
			var blockLocal;
		}
	}
});`

	checkCallbackOffsets(t, body, []string{"a = 1", "b;", "i = 0", "c;"}, func(cb *facts.Callback) []facts.NodeID { return cb.VarDecls })
}

func TestAnalyze_WhenAVarRedeclaresAPatternBinding_RecordsAParamRedeclaration(t *testing.T) {
	t.Parallel()
	body := `each(s, ({ id, Position: p, Velocity: { dx: vx } }: any) => {
	var p;
	var other = 1, vx: any = 2;
	{
		var id: any = 0;
	}
	let shadow = 0;
	function inner() {
		var p;
	}
});`

	checkCallbackOffsets(t, body, []string{"p;", "vx: any = 2", "id: any = 0"}, func(cb *facts.Callback) []facts.NodeID { return cb.ParamRedeclarations })
}

func TestAnalyze_WhenCallbackCallsEval_RecordsEveryDirectCall(t *testing.T) {
	t.Parallel()
	body := `each(s, (e: any) => {
	eval("e");
	(() => eval("1"))();
	const indirect = eval;
	indirect("2");
	globalThis.eval("3");
	eval?.("4");
	(eval)("5");
	eval!("6");
	(eval as any)("7");
	(eval satisfies unknown as typeof eval)("8");
	(<any>eval)("9");
	(0, eval)("10");
	(eval)?.("11");
});`
	marks := []string{`eval("e")`, `eval("1")`, `(eval)("5")`, `eval!("6")`, `(eval as any)("7")`, `(eval satisfies`, `(<any>eval)("9")`}

	checkCallbackOffsets(t, body, marks, func(cb *facts.Callback) []facts.NodeID { return cb.DirectEval })
}
