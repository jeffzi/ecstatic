package plan_test

import (
	"slices"
	"testing"

	"github.com/google/go-cmp/cmp"

	"github.com/jeffzi/ecstatic/optimizer/internal/facts"
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

func TestPlan_WhenSitesNest_BailsInPostOrderBySourceOffset(t *testing.T) {
	t.Parallel()
	has := statement(facts.OpHas, nil)
	each := statement(facts.OpEach, inlineArrow())
	sites := []facts.Site{
		placed(each, 0, 50,
			placed(each, 1, 70, placed(has, 2, 80)),
			placed(has, 3, 60),
		),
		placed(has, 4, 10),
	}
	want := []plan.Bail{
		{Call: 4, Op: facts.OpHas, Reason: facts.ReasonOpNotRewritten, Pos: at(10)},
		{Call: 3, Op: facts.OpHas, Reason: facts.ReasonOpNotRewritten, Pos: at(60)},
		{Call: 2, Op: facts.OpHas, Reason: facts.ReasonOpNotRewritten, Pos: at(80)},
		{Call: 1, Op: facts.OpEach, Reason: facts.ReasonOpNotRewritten, Pos: at(70)},
		{Call: 0, Op: facts.OpEach, Reason: facts.ReasonOpNotRewritten, Pos: at(50)},
	}

	got := plan.Plan(sites)

	if diff := cmp.Diff(want, got); diff != "" {
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
		{"arrow body counts as a statement", facts.Site{Op: each, Context: facts.ContextArrowBody}, facts.ReasonCallbackNotInline},
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
	each := facts.OpEach
	objectPattern := &facts.Callback{Arrow: true, Params: 1, FirstParam: facts.ParamObjectPattern}
	return []reasonCase{
		{"object pattern passes callback params", statement(each, objectPattern, facts.ReasonShapeUnresolved), facts.ReasonShapeUnresolved},
		{"no parameter passes callback params", statement(each, &facts.Callback{Arrow: true}), facts.ReasonOpNotRewritten},
		{
			"first recorded reason wins",
			statement(each, inlineArrow(), facts.ReasonShapeUnresolved, facts.ReasonStoragesDynamic),
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

			got := plan.Plan([]facts.Site{tt.site})

			if len(got) != 1 {
				t.Fatalf("Plan(%s) = %d bails, want 1", tt.name, len(got))
			}
			if got[0].Reason != tt.want {
				t.Errorf("Plan(%s) reason = %s, want %s", tt.name, got[0].Reason.Info().ID, tt.want.Info().ID)
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

type panicCase struct {
	panicValue string
	name       string
	sites      []facts.Site
	want       []plan.Bail
	panicCall  facts.NodeID
}

// panicCases pin that a panic while planning one site bails only that site as internal, whether the site encloses others or is nested.
func panicCases() []panicCase {
	has := statement(facts.OpHas, nil)
	return []panicCase{
		{
			name:       "enclosing site panics",
			panicValue: "storage table is empty",
			panicCall:  0,
			sites: []facts.Site{
				placed(statement(facts.OpEach, inlineArrow()), 0, 0, placed(has, 1, 10)),
				placed(has, 2, 30),
			},
			want: []plan.Bail{
				{Call: 1, Op: facts.OpHas, Reason: facts.ReasonNotStatement, Pos: at(10)},
				{Call: 0, Op: facts.OpEach, Reason: facts.ReasonInternal, Pos: at(0), Detail: "storage table is empty"},
				{Call: 2, Op: facts.OpHas, Reason: facts.ReasonNotStatement, Pos: at(30)},
			},
		},
		{
			name:       "nested site panics",
			panicValue: "shape table is empty",
			panicCall:  1,
			sites: []facts.Site{
				placed(statement(facts.OpEach, inlineArrow()), 0, 0, placed(has, 1, 10), placed(has, 2, 20)),
				placed(has, 3, 30),
			},
			want: []plan.Bail{
				{Call: 1, Op: facts.OpHas, Reason: facts.ReasonInternal, Pos: at(10), Detail: "shape table is empty"},
				{Call: 2, Op: facts.OpHas, Reason: facts.ReasonNotStatement, Pos: at(20)},
				{Call: 0, Op: facts.OpEach, Reason: facts.ReasonNotStatement, Pos: at(0)},
				{Call: 3, Op: facts.OpHas, Reason: facts.ReasonNotStatement, Pos: at(30)},
			},
		},
	}
}

func TestPlan_WhenPlanningASitePanics_BailsOnlyThatSiteAsInternal(t *testing.T) {
	t.Parallel()
	for _, tt := range panicCases() {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			decide := func(site facts.Site) facts.Reason {
				if site.Call == tt.panicCall {
					panic(tt.panicValue)
				}
				return facts.ReasonNotStatement
			}

			got := plan.PlanWith(tt.sites, decide)

			if diff := cmp.Diff(tt.want, got); diff != "" {
				t.Errorf("PlanWith() mismatch (-want +got):\n%s", diff)
			}
		})
	}
}
