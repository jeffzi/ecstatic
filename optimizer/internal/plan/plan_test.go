package plan_test

import (
	"slices"
	"testing"

	"github.com/google/go-cmp/cmp"
	"github.com/google/go-cmp/cmp/cmpopts"

	"github.com/jeffzi/ecstatic/optimizer/internal/facts"
	_ "github.com/jeffzi/ecstatic/optimizer/internal/golden" // registers -update, which go test ./... -update passes to every test binary
	"github.com/jeffzi/ecstatic/optimizer/internal/plan"
)

// at is the position of a call starting at offset on the first line of main.ts.
func at(offset int) facts.Position {
	return facts.Position{File: "main.ts", Offset: offset, Line: 1, Column: offset + 1}
}

// inlineArrow is an arrow callback with one plain identifier parameter, which passes every callback check.
func inlineArrow() *facts.Callback {
	return &facts.Callback{Arrow: true, Params: 1, FirstParam: facts.ParamIdentifier}
}

// statement is a site for op whose call is the whole expression of a statement.
func statement(op facts.Op, callback *facts.Callback, reasons ...facts.Reason) facts.Site {
	return facts.Site{Op: op, Context: facts.ContextExpressionStatement, Callback: callback, Reasons: reasons}
}

// placed is site with its call ID, position, and nested sites set.
func placed(site facts.Site, call facts.NodeID, offset int, nested ...facts.Site) facts.Site {
	site.Call = call
	site.Pos = at(offset)
	site.Nested = nested
	return site
}

// valued is site with its call's value used.
func valued(site facts.Site) facts.Site {
	site.Context = facts.ContextOtherExpression
	return site
}

// filtered is site with a filter argument.
func filtered(site facts.Site) facts.Site {
	site.Filtered = true
	return site
}

// arrayLiteral is site passing its storages as an array literal.
func arrayLiteral(site facts.Site) facts.Site {
	site.ArrayLiteral = true
	return site
}

// over is site iterating storages of shapes.
func over(site facts.Site, shapes ...facts.ArchShape) facts.Site {
	site.Shapes = shapes
	return site
}

// moverShape is an archetype with one required component of two number fields.
func moverShape() facts.ArchShape {
	return facts.ArchShape{Required: []facts.Component{{
		Name:   "Position",
		Fields: []facts.Field{{Name: "x", Kind: facts.FieldNumber}, {Name: "y", Kind: facts.FieldNumber}},
	}}}
}

// statueShape is an archetype with one required tag.
func statueShape() facts.ArchShape {
	return facts.ArchShape{Required: []facts.Component{{Name: "Statue"}}}
}

// hazardous is an inline arrow callback whose body has one hazard point.
func hazardous() *facts.Callback {
	cb := inlineArrow()
	cb.Hazards = []facts.NodeID{7}
	return cb
}

// keptCallback is a callback that keeps its call a runtime call: it takes two parameters.
func keptCallback() *facts.Callback {
	return &facts.Callback{Arrow: true, Params: 2, FirstParam: facts.ParamIdentifier}
}

// eachAt is an each call over moverShape with ID call at offset, whose callback is cb, holding nested.
func eachAt(call facts.NodeID, offset int, cb *facts.Callback, nested ...facts.Site) facts.Site {
	return placed(over(statement(facts.OpEach, cb), moverShape()), call, offset, nested...)
}

// inlinedAt is the Hoisted inlining of an each call over moverShape with ID call at offset.
func inlinedAt(call facts.NodeID, offset int) plan.EachInlining {
	return plan.EachInlining{Call: call, Pos: at(offset), Shape: moverShape(), Mode: plan.ModeHoisted}
}

// bailAt is the bail of the each call with ID call at offset for reason.
func bailAt(call facts.NodeID, offset int, reason facts.Reason) plan.Bail {
	return plan.Bail{Call: call, Op: facts.OpEach, Reason: reason, Pos: at(offset)}
}

func TestPlan_WhenSitesNest_BailsInPostOrderBySourceOffset(t *testing.T) {
	t.Parallel()
	has := statement(facts.OpHas, nil)
	sites := []facts.Site{
		filtered(eachAt(0, 50, inlineArrow(),
			filtered(eachAt(1, 70, inlineArrow(), placed(has, 2, 80))),
			placed(has, 3, 60),
		)),
		placed(has, 4, 10),
	}
	want := []plan.Bail{
		{Call: 4, Op: facts.OpHas, Reason: facts.ReasonOpNotRewritten, Pos: at(10)},
		{Call: 3, Op: facts.OpHas, Reason: facts.ReasonOpNotRewritten, Pos: at(60)},
		{Call: 2, Op: facts.OpHas, Reason: facts.ReasonOpNotRewritten, Pos: at(80)},
		bailAt(1, 70, facts.ReasonOpNotRewritten),
		bailAt(0, 50, facts.ReasonOpNotRewritten),
	}

	got := plan.Plan(sites)

	if diff := cmp.Diff(plan.Result{Bails: want}, got, cmpopts.EquateEmpty()); diff != "" {
		t.Errorf("Plan() mismatch (-want +got):\n%s", diff)
	}
}

type reasonCase struct {
	name string
	site facts.Site
	want facts.Reason
}

// statementAndCallbackCases pin the reasons up to the callback checks, and their order where a later reason also applies.
func statementAndCallbackCases() []reasonCase {
	each := facts.OpEach
	return []reasonCase{
		{"arg count before not statement", valued(statement(each, nil, facts.ReasonArgCount)), facts.ReasonArgCount},
		{"not statement before callback not inline", valued(statement(each, nil)), facts.ReasonNotStatement},
		{
			"callback not inline before storages dynamic",
			statement(each, nil, facts.ReasonStoragesDynamic), facts.ReasonCallbackNotInline,
		},
		{"async before generator", statement(each, &facts.Callback{Async: true, Generator: true}), facts.ReasonCallbackAsync},
		{"generator before params", statement(each, &facts.Callback{Generator: true, Params: 2}), facts.ReasonCallbackGenerator},
		{
			"other first parameter before function bindings",
			statement(each, &facts.Callback{Params: 1, FirstParam: facts.ParamOther, FunctionLocal: []facts.NodeID{5}}),
			facts.ReasonCallbackParams,
		},
		{
			"two parameters before function bindings",
			statement(each, &facts.Callback{Params: 2, FirstParam: facts.ParamIdentifier, FunctionLocal: []facts.NodeID{5}}),
			facts.ReasonCallbackParams,
		},
		{
			"var redeclaring a destructured parameter before function bindings",
			statement(each, &facts.Callback{
				Params: 1, FirstParam: facts.ParamObjectPattern, ParamRedeclarations: []facts.NodeID{4}, FunctionLocal: []facts.NodeID{5},
			}),
			facts.ReasonCallbackParams,
		},
		{
			"function bindings before storages dynamic",
			statement(each, &facts.Callback{Params: 1, FirstParam: facts.ParamIdentifier, FunctionLocal: []facts.NodeID{5}},
				facts.ReasonStoragesDynamic),
			facts.ReasonCallbackFunctionBindings,
		},
		{"query callback not inline", statement(facts.OpQuery, nil), facts.ReasonCallbackNotInline},
	}
}

// storageAndFallbackCases pin the order of the reasons after the callback checks.
func storageAndFallbackCases() []reasonCase {
	return []reasonCase{
		{
			"first recorded reason wins",
			statement(facts.OpEach, inlineArrow(), facts.ReasonShapeUnresolved, facts.ReasonStoragesDynamic),
			facts.ReasonShapeUnresolved,
		},
		{"other op skips the callback checks", statement(facts.OpHas, nil), facts.ReasonOpNotRewritten},
		{"other op surfaces a recorded reason", statement(facts.OpHas, nil, facts.ReasonShapeUnresolved), facts.ReasonShapeUnresolved},
		{"other op with its value used", valued(statement(facts.OpSpawn, nil)), facts.ReasonNotStatement},
	}
}

func TestPlan_PicksTheFirstReasonThatApplies(t *testing.T) {
	t.Parallel()
	for _, tt := range slices.Concat(statementAndCallbackCases(), storageAndFallbackCases()) {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()

			got := plan.Plan([]facts.Site{tt.site}).Bails

			if len(got) != 1 {
				t.Fatalf("Plan(%s) = %d bails, want 1", tt.name, len(got))
			}
			if got[0].Reason != tt.want {
				t.Errorf("Plan(%s) reason = %s, want %s", tt.name, got[0].Reason.Info().ID, tt.want.Info().ID)
			}
		})
	}
}

func TestPlan_WhenAnEachSiteIsEligible_PlansAnInliningInsteadOfABail(t *testing.T) {
	t.Parallel()
	each := facts.OpEach
	objectPattern := &facts.Callback{Arrow: true, Params: 1, FirstParam: facts.ParamObjectPattern}
	returns := []facts.Return{{Node: 11}, {Node: 12, Nested: true}}
	vars := []facts.NodeID{21, 22}
	carrying := inlineArrow()
	carrying.Returns = returns
	carrying.VarDecls = vars
	tests := []struct {
		continues []facts.Return
		varToLet  []facts.NodeID
		name      string
		site      facts.Site
		mode      plan.Mode
	}{
		{
			name:      "expression statement with a hazard-free body carrying returns and var declarations",
			site:      statement(each, carrying),
			mode:      plan.ModeHoisted,
			continues: returns,
			varToLet:  vars,
		},
		{
			name: "arrow body",
			site: facts.Site{Op: each, Context: facts.ContextArrowBody, Callback: inlineArrow()},
			mode: plan.ModeHoisted,
		},
		{name: "body with a hazard point", site: statement(each, hazardous()), mode: plan.ModeReallocSafe},
		{name: "object-pattern parameter", site: statement(each, objectPattern), mode: plan.ModeHoisted},
		{name: "no parameter", site: statement(each, &facts.Callback{Arrow: true}), mode: plan.ModeHoisted},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			site := placed(over(tt.site, moverShape()), 3, 40)
			want := plan.Result{Rewrites: []plan.EachInlining{{
				Call: 3, Pos: at(40), Shape: moverShape(), Mode: tt.mode, Continues: tt.continues, VarToLet: tt.varToLet,
			}}}

			got := plan.Plan([]facts.Site{site})

			if diff := cmp.Diff(want, got, cmpopts.EquateEmpty()); diff != "" {
				t.Errorf("Plan(%s) mismatch (-want +got):\n%s", tt.name, diff)
			}
		})
	}
}

// escapeAt is a view escape of kind at line and column of main.ts; its offset orders escapes by line, then column.
func escapeAt(kind facts.EscapeKind, line, column int) facts.ViewEscape {
	return facts.ViewEscape{
		Kind: kind,
		Pos:  facts.Position{File: "main.ts", Offset: line*100 + column, Line: line, Column: column},
	}
}

// fromLoop is a reference to the view at line and column from the callback of the nested loop whose call is loop.
func fromLoop(loop facts.NodeID, line, column int) facts.ViewEscape {
	escape := escapeAt(facts.EscapeNestedLoop, line, column)
	escape.Loop = loop
	return escape
}

// escaping is an inline arrow callback, which passes every callback check, whose view references escape at escapes.
func escaping(escapes ...facts.ViewEscape) *facts.Callback {
	cb := inlineArrow()
	cb.Escapes = escapes
	return cb
}

// viewEscapes is the VIEW_ESCAPES bail of the each call call at offset, whose message names detail.
func viewEscapes(call facts.NodeID, offset int, detail string) plan.Bail {
	return plan.Bail{Call: call, Op: facts.OpEach, Reason: facts.ReasonViewEscapes, Pos: at(offset), Detail: detail}
}

func TestPlan_WhenAViewReferenceEscapes_BailsNamingItsLineColumnAndUse(t *testing.T) {
	t.Parallel()
	tests := []struct {
		use  string
		kind facts.EscapeKind
	}{
		{kind: facts.EscapeView, use: "the view as a value"},
		{kind: facts.EscapeComputed, use: "a computed access"},
		{kind: facts.EscapeSlotValue, use: "a slot as a value"},
		{kind: facts.EscapeKey, use: "a key outside the shape"},
		{kind: facts.EscapeSlotAssign, use: "an assignment to a slot"},
		{kind: facts.EscapeChain, use: "an optional chain past a field"},
		{kind: facts.EscapeNested, use: "a reference from a nested function"},
		{kind: facts.EscapeDestructure, use: "a destructuring form that does not lower"},
		{kind: facts.EscapeFieldCall, use: "a field called as a method"},
		{kind: facts.EscapeBooleanArithmetic, use: "arithmetic on a boolean field"},
		{kind: facts.EscapeEval, use: "a direct eval"},
	}
	for _, tt := range tests {
		t.Run(tt.use, func(t *testing.T) {
			t.Parallel()
			site := eachAt(2, 20, escaping(escapeAt(tt.kind, 3, 7)))
			want := plan.Result{Bails: []plan.Bail{viewEscapes(2, 20, "line 3, column 7: "+tt.use)}}

			got := plan.Plan([]facts.Site{site})

			if diff := cmp.Diff(want, got, cmpopts.EquateEmpty()); diff != "" {
				t.Errorf("Plan(each with %s) mismatch (-want +got):\n%s", tt.use, diff)
			}
		})
	}
}

func TestPlan_WhenSeveralViewReferencesEscape_ReportsTheFirstInSourceOrder(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name    string
		escapes []facts.ViewEscape
		want    plan.Bail
	}{
		{
			name:    "the earliest escape is named whatever the recorded order",
			escapes: []facts.ViewEscape{escapeAt(facts.EscapeView, 5, 2), escapeAt(facts.EscapeKey, 3, 9)},
			want:    viewEscapes(2, 20, "line 3, column 9: a key outside the shape"),
		},
		{
			name:    "a field target first reports an unsupported assignment",
			escapes: []facts.ViewEscape{escapeAt(facts.EscapeTarget, 3, 4), escapeAt(facts.EscapeView, 4, 2)},
			want:    bailAt(2, 20, facts.ReasonUnsupportedAssignment),
		},
		{
			name:    "an escape before a field target reports view escapes",
			escapes: []facts.ViewEscape{escapeAt(facts.EscapeView, 3, 4), escapeAt(facts.EscapeTarget, 4, 2)},
			want:    viewEscapes(2, 20, "line 3, column 4: the view as a value"),
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			site := eachAt(2, 20, escaping(tt.escapes...))

			got := plan.Plan([]facts.Site{site})

			if diff := cmp.Diff(plan.Result{Bails: []plan.Bail{tt.want}}, got, cmpopts.EquateEmpty()); diff != "" {
				t.Errorf("Plan(%s) mismatch (-want +got):\n%s", tt.name, diff)
			}
		})
	}
}

func TestPlan_WhenTheCallFormHasNoRewrite_BailsSilentlyUnlessAFilteredEachEscapes(t *testing.T) {
	t.Parallel()
	cb := escaping(escapeAt(facts.EscapeView, 3, 7))
	notRewritten := bailAt(2, 20, facts.ReasonOpNotRewritten)
	tests := []struct {
		name string
		site facts.Site
		want plan.Bail
	}{
		{name: "filtered each", site: filtered(eachAt(2, 20, inlineArrow())), want: notRewritten},
		{
			name: "filtered each with an escaping view reference",
			site: filtered(eachAt(2, 20, cb)),
			want: viewEscapes(2, 20, "line 3, column 7: the view as a value"),
		},
		{
			name: "each over an array literal of one storage with an escaping view reference",
			site: arrayLiteral(eachAt(2, 20, cb)),
			want: notRewritten,
		},
		{
			name: "each over an array literal of two storages",
			site: arrayLiteral(over(eachAt(2, 20, inlineArrow()), moverShape(), statueShape())),
			want: notRewritten,
		},
		{
			name: "query with an escaping view reference",
			site: placed(statement(facts.OpQuery, cb), 2, 20),
			want: plan.Bail{Call: 2, Op: facts.OpQuery, Reason: facts.ReasonOpNotRewritten, Pos: at(20)},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()

			got := plan.Plan([]facts.Site{tt.site})

			if diff := cmp.Diff(plan.Result{Bails: []plan.Bail{tt.want}}, got, cmpopts.EquateEmpty()); diff != "" {
				t.Errorf("Plan(%s) mismatch (-want +got):\n%s", tt.name, diff)
			}
		})
	}
}

// keptLoopUse is the use an escape from the callback of a nested each that keeps its runtime call names.
const keptLoopUse = "a reference from a nested callback that keeps its runtime call"

type nestedCase struct {
	want  plan.Result
	name  string
	outer facts.Site
}

// twoLevelCases nest one each in another, the inner inlined or kept, with or without outer view references in it.
func twoLevelCases() []nestedCase {
	inlined, kept := eachAt(2, 30, inlineArrow()), eachAt(2, 30, keptCallback())
	silent := bailAt(1, 10, facts.ReasonOpNotRewritten)
	return []nestedCase{
		{
			name:  "an each holding an inlined each keeps its runtime call silently",
			outer: eachAt(1, 10, escaping(), inlined),
			want:  plan.Result{Bails: []plan.Bail{silent}, Rewrites: []plan.EachInlining{inlinedAt(2, 30)}},
		},
		{
			name:  "a reference from the callback of an inlined each does not escape",
			outer: eachAt(1, 10, escaping(fromLoop(2, 3, 9)), inlined),
			want:  plan.Result{Bails: []plan.Bail{silent}, Rewrites: []plan.EachInlining{inlinedAt(2, 30)}},
		},
		{
			name:  "a reference from the callback of an each that keeps its runtime call escapes",
			outer: eachAt(1, 10, escaping(fromLoop(2, 3, 9)), kept),
			want: plan.Result{Bails: []plan.Bail{
				bailAt(2, 30, facts.ReasonCallbackParams),
				viewEscapes(1, 10, "line 3, column 9: "+keptLoopUse),
			}},
		},
		{
			name:  "an each holding an each that keeps its runtime call is inlined when nothing escapes",
			outer: eachAt(1, 10, escaping(), kept),
			want: plan.Result{
				Bails:    []plan.Bail{bailAt(2, 30, facts.ReasonCallbackParams)},
				Rewrites: []plan.EachInlining{inlinedAt(1, 10)},
			},
		},
		{
			name:  "an escape outside the inner callback is reported even when the inner each is inlined",
			outer: eachAt(1, 10, escaping(escapeAt(facts.EscapeView, 6, 2)), inlined),
			want: plan.Result{
				Bails:    []plan.Bail{viewEscapes(1, 10, "line 6, column 2: the view as a value")},
				Rewrites: []plan.EachInlining{inlinedAt(2, 30)},
			},
		},
		{
			name:  "a reference from the callback of an inlined each is passed over for the first escape",
			outer: eachAt(1, 10, escaping(fromLoop(2, 3, 9), escapeAt(facts.EscapeView, 6, 2)), inlined),
			want: plan.Result{
				Bails:    []plan.Bail{viewEscapes(1, 10, "line 6, column 2: the view as a value")},
				Rewrites: []plan.EachInlining{inlinedAt(2, 30)},
			},
		},
	}
}

// threeLevelCases nest an inlined each in an each that keeps its runtime call, inside a third each.
func threeLevelCases() []nestedCase {
	middle := eachAt(2, 30, keptCallback(), eachAt(3, 50, inlineArrow()))
	return []nestedCase{
		{
			name:  "a reference from an inlined callback inside a kept callback escapes",
			outer: eachAt(1, 10, escaping(fromLoop(3, 4, 11)), middle),
			want: plan.Result{
				Bails: []plan.Bail{
					bailAt(2, 30, facts.ReasonCallbackParams),
					viewEscapes(1, 10, "line 4, column 11: "+keptLoopUse),
				},
				Rewrites: []plan.EachInlining{inlinedAt(3, 50)},
			},
		},
		{
			name:  "an each holding an inlined each at any depth keeps its runtime call silently",
			outer: eachAt(1, 10, escaping(), middle),
			want: plan.Result{
				Bails:    []plan.Bail{bailAt(2, 30, facts.ReasonCallbackParams), bailAt(1, 10, facts.ReasonOpNotRewritten)},
				Rewrites: []plan.EachInlining{inlinedAt(3, 50)},
			},
		},
	}
}

func TestPlan_WhenAnEachNestsAnotherEach_PlansTheInnerFirst(t *testing.T) {
	t.Parallel()
	for _, tt := range slices.Concat(twoLevelCases(), threeLevelCases()) {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()

			got := plan.Plan([]facts.Site{tt.outer})

			if diff := cmp.Diff(tt.want, got, cmpopts.EquateEmpty()); diff != "" {
				t.Errorf("Plan(%s) mismatch (-want +got):\n%s", tt.name, diff)
			}
		})
	}
}

func TestBail_Reported(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name   string
		reason facts.Reason
		strict bool
		want   bool
	}{
		{name: "silent under strict", reason: facts.ReasonNotStatement, strict: true, want: false},
		{name: "silent without strict", reason: facts.ReasonOpNotRewritten, strict: false, want: false},
		{name: "strict under strict", reason: facts.ReasonShapeUnresolved, strict: true, want: true},
		{name: "strict without strict", reason: facts.ReasonShapeUnresolved, strict: false, want: false},
		{name: "warning under strict", reason: facts.ReasonCallbackAsync, strict: true, want: true},
		{name: "warning without strict", reason: facts.ReasonCallbackAsync, strict: false, want: true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			bail := plan.Bail{Reason: tt.reason}

			got := bail.Reported(tt.strict)

			if got != tt.want {
				t.Errorf("Bail{Reason: %s}.Reported(%t) = %t, want %t", tt.reason.Info().ID, tt.strict, got, tt.want)
			}
		})
	}
}

// shapelessDetail is the detail of the INTERNAL bail of an eligible each site that holds no shape.
const shapelessDetail = "eligible each site has 0 shapes, want 1"

type panicCase struct {
	want  plan.Result
	name  string
	sites []facts.Site
}

// panicCases pin that a panic while planning one site, an eligible each that holds no shape, bails only that site
// as internal, whether the site encloses others or is nested.
func panicCases() []panicCase {
	has := statement(facts.OpHas, nil)
	shapeless := statement(facts.OpEach, inlineArrow())
	return []panicCase{
		{
			name:  "enclosing site panics",
			sites: []facts.Site{placed(shapeless, 0, 0, placed(has, 1, 10)), placed(has, 2, 30)},
			want: plan.Result{Bails: []plan.Bail{
				{Call: 0, Op: facts.OpEach, Reason: facts.ReasonInternal, Pos: at(0), Detail: shapelessDetail},
				{Call: 1, Op: facts.OpHas, Reason: facts.ReasonOpNotRewritten, Pos: at(10)},
				{Call: 2, Op: facts.OpHas, Reason: facts.ReasonOpNotRewritten, Pos: at(30)},
			}},
		},
		{
			name: "nested site panics",
			sites: []facts.Site{
				eachAt(0, 0, inlineArrow(), placed(shapeless, 1, 10), placed(has, 2, 20)),
				placed(has, 3, 30),
			},
			want: plan.Result{
				Bails: []plan.Bail{
					{Call: 1, Op: facts.OpEach, Reason: facts.ReasonInternal, Pos: at(10), Detail: shapelessDetail},
					{Call: 2, Op: facts.OpHas, Reason: facts.ReasonOpNotRewritten, Pos: at(20)},
					{Call: 3, Op: facts.OpHas, Reason: facts.ReasonOpNotRewritten, Pos: at(30)},
				},
				Rewrites: []plan.EachInlining{inlinedAt(0, 0)},
			},
		},
	}
}

func TestPlan_WhenPlanningASitePanics_BailsOnlyThatSiteAsInternal(t *testing.T) {
	t.Parallel()
	byCall := cmpopts.SortSlices(func(a, b plan.Bail) bool { return a.Call < b.Call })
	for _, tt := range panicCases() {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()

			got := plan.Plan(tt.sites)

			if diff := cmp.Diff(tt.want, got, cmpopts.EquateEmpty(), byCall); diff != "" {
				t.Errorf("Plan(%s) mismatch (-want +got):\n%s", tt.name, diff)
			}
		})
	}
}
