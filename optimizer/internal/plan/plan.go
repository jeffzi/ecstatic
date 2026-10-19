// Package plan decides, for every ecstatic call site analysis reported, how
// the optimizer treats it. It imports facts and the standard library only, so
// the decisions never depend on the compiler.
package plan

import (
	"cmp"
	"fmt"
	"slices"

	"github.com/jeffzi/ecstatic/optimizer/internal/facts"
)

// Bail is a call site that keeps its runtime call, with the reason it does.
type Bail struct {
	// Detail is the recovered panic's message for an INTERNAL bail, and the
	// line, column, and use of the first escaping reference for a
	// VIEW_ESCAPES bail; empty for every other reason.
	Detail string
	Pos    facts.Position
	Call   facts.NodeID
	Op     facts.Op
	Reason facts.Reason
}

// Reported reports whether b produces a diagnostic: always for a warning
// reason, only under strict for a strict reason, never for a silent one.
func (b Bail) Reported(strict bool) bool {
	switch b.Reason.Info().Category {
	case facts.CategoryWarning:
		return true
	case facts.CategoryStrict:
		return strict
	default:
		return false
	}
}

// Internal returns b as an INTERNAL bail whose Detail is the message of recovered, a value
// recover returned.
func (b Bail) Internal(recovered any) Bail {
	b.Reason = facts.ReasonInternal
	b.Detail = fmt.Sprint(recovered)
	return b
}

// Mode is how an inlined loop reads the storage's arrays.
type Mode uint8

// The two modes of an inlined loop.
const (
	// ModeHoisted reads each touched column, and the mask and entity arrays,
	// into locals once per call: the body has no hazard point, so no array is
	// replaced while the loop runs.
	ModeHoisted Mode = iota + 1
	// ModeReallocSafe reads every array through the storage's component
	// records on each access: a hazard point in the body may grow the storage,
	// which replaces its arrays.
	ModeReallocSafe
)

// EachInlining is an each call site whose runtime call becomes an inlined
// loop over the columns of its one storage.
type EachInlining struct {
	// Shape is the storage's archetype shape, which the loop is compiled
	// against.
	Shape facts.ArchShape
	// Continues are the callback's own return statements, each of which ends
	// the row as the runtime's return from the callback does.
	Continues []facts.Return
	// VarToLet are the declarations of the callback's own var statements and
	// for heads, whose names the row binds afresh, as each call of the
	// callback does.
	VarToLet []facts.NodeID
	Pos      facts.Position
	Call     facts.NodeID
	Mode     Mode
}

// Result is the plan of one file: the sites that keep their runtime call,
// and the sites that are rewritten.
type Result struct {
	Bails    []Bail
	Rewrites []EachInlining
}

// Plan decides the sites of one file, nested sites included: an eligible each
// site gets an inlining, every other site a bail.
//
// Bails and rewrites are each in post-order: the sites of one level (the
// file's top level, or the nested sites of one callback) in ascending source
// offset, each one preceded by its own nested sites. A nested call's outcome
// therefore comes before its enclosing call's, although the enclosing call
// starts first: an enclosing site is decided only once every site inside its
// callback is, because whether a reference to its view from a nested
// callback escapes depends on whether that callback is inlined.
//
// A panic while deciding one site makes that site an INTERNAL bail carrying
// the panic's message; every other site is decided as usual.
func Plan(sites []facts.Site) Result {
	p := planner{inlined: map[facts.NodeID]bool{}}
	p.appendSites(sites)
	return p.result
}

// planner accumulates the plan of one file.
type planner struct {
	// inlined holds the call of every site decided so far that is rewritten.
	inlined map[facts.NodeID]bool
	result  Result
}

// appendSites appends the outcomes of sites and of their nested sites, in
// Plan's order.
func (p *planner) appendSites(sites []facts.Site) {
	bySource := slices.SortedStableFunc(slices.Values(sites), func(a, b facts.Site) int {
		return cmp.Compare(a.Pos.Offset, b.Pos.Offset)
	})
	for _, site := range bySource {
		p.appendSites(site.Nested)
		inlining, bail, eligible := p.decideSite(site)
		if eligible {
			p.inlined[site.Call] = true
			p.result.Rewrites = append(p.result.Rewrites, inlining)
		} else {
			p.result.Bails = append(p.result.Bails, bail)
		}
	}
}

// decideSite returns the inlining of site and true when it is eligible, and
// otherwise its bail: an INTERNAL one when deciding it panics. Every site
// nested in site must already be decided.
func (p *planner) decideSite(site facts.Site) (inlining EachInlining, bail Bail, eligible bool) {
	bail = Bail{Call: site.Call, Op: site.Op, Pos: site.Pos}
	defer func() {
		if recovered := recover(); recovered != nil {
			bail = bail.Internal(recovered)
			eligible = false
		}
	}()
	bail.Reason = reason(site)
	if bail.Reason == facts.ReasonNone {
		bail.Reason, bail.Detail = p.escapeReason(site)
	}
	if bail.Reason == facts.ReasonNone && (site.Filtered || p.holdsInlined(site.Nested)) {
		bail.Reason = facts.ReasonOpNotRewritten
	}
	if bail.Reason != facts.ReasonNone {
		return EachInlining{}, bail, false
	}
	return eachInlining(site), bail, true
}

// escapeReason returns the reason the first escaping reference of site's
// callback, in source order, keeps the runtime call, with the bail's detail:
// UNSUPPORTED_ASSIGNMENT for a field written as a pattern or for…of target,
// VIEW_ESCAPES naming the reference's line, column, and use for any other.
// A reference from a nested callback that is inlined, inside nested
// callbacks that all are, is a use of the view and not an escape. It returns
// facts.ReasonNone when no reference escapes.
func (p *planner) escapeReason(site facts.Site) (facts.Reason, string) {
	var first *facts.ViewEscape
	for i, escape := range site.Callback.Escapes {
		if escape.Kind == facts.EscapeNestedLoop && p.inlinedPath(site.Nested, escape.Loop) {
			continue
		}
		if first == nil || escape.Pos.Offset < first.Pos.Offset {
			first = &site.Callback.Escapes[i]
		}
	}
	switch {
	case first == nil:
		return facts.ReasonNone, ""
	case first.Kind == facts.EscapeTarget:
		return facts.ReasonUnsupportedAssignment, ""
	default:
		return facts.ReasonViewEscapes, fmt.Sprintf("line %d, column %d: %s", first.Pos.Line, first.Pos.Column, escapeUse(first.Kind))
	}
}

// inlinedPath reports whether the site whose call is loop lies among sites, at
// any depth, with it and every site enclosing it there inlined.
func (p *planner) inlinedPath(sites []facts.Site, loop facts.NodeID) bool {
	for _, site := range sites {
		if p.inlined[site.Call] && (site.Call == loop || p.inlinedPath(site.Nested, loop)) {
			return true
		}
	}
	return false
}

// holdsInlined reports whether any of sites, at any depth, is inlined: an
// enclosing each keeps its runtime call then, because inlining it would need
// loop composition.
func (p *planner) holdsInlined(sites []facts.Site) bool {
	return slices.ContainsFunc(sites, func(site facts.Site) bool {
		return p.inlined[site.Call] || p.holdsInlined(site.Nested)
	})
}

// escapeUse names the use an escape of kind makes, for a VIEW_ESCAPES
// message. EscapeTarget has none: it reports UNSUPPORTED_ASSIGNMENT.
func escapeUse(kind facts.EscapeKind) string {
	uses := [...]string{
		facts.EscapeView:              "the view as a value",
		facts.EscapeComputed:          "a computed access",
		facts.EscapeSlotValue:         "a slot as a value",
		facts.EscapeKey:               "a key outside the shape",
		facts.EscapeSlotAssign:        "an assignment to a slot",
		facts.EscapeChain:             "an optional chain past a field",
		facts.EscapeNested:            "a reference from a nested function",
		facts.EscapeNestedLoop:        "a reference from a nested callback that keeps its runtime call",
		facts.EscapeDestructure:       "a destructuring form that does not lower",
		facts.EscapeFieldCall:         "a field called as a method",
		facts.EscapeBooleanArithmetic: "arithmetic on a boolean field",
		facts.EscapeEval:              "a direct eval",
	}
	return uses[kind]
}

// eachInlining returns the inlining of site, an eligible each site. It panics
// when site does not hold exactly one shape: analysis records
// SHAPE_UNRESOLVED or STORAGES_DYNAMIC on every each site whose storage does
// not resolve, so an eligible site without one shape is an analysis bug.
func eachInlining(site facts.Site) EachInlining {
	if len(site.Shapes) != 1 {
		panic(fmt.Sprintf("eligible each site has %d shapes, want 1", len(site.Shapes)))
	}
	mode := ModeHoisted
	if len(site.Callback.Hazards) > 0 {
		mode = ModeReallocSafe
	}
	return EachInlining{
		Call:      site.Call,
		Pos:       site.Pos,
		Shape:     site.Shapes[0],
		Mode:      mode,
		Continues: site.Callback.Returns,
		VarToLet:  site.Callback.VarDecls,
	}
}

// reason returns the first reason that applies to site, in this order:
// argument count, statement context, the callback of an iteration op, the
// first reason analysis recorded on site (whatever the reason and the op),
// and the op or call form having no rewrite: every op but each, and each over
// an array literal. It returns facts.ReasonNone for an each site over one
// storage, filtered or not, whose view escapes and nesting are still to be
// checked.
func reason(site facts.Site) facts.Reason {
	if slices.Contains(site.Reasons, facts.ReasonArgCount) {
		return facts.ReasonArgCount
	}
	if site.Context == facts.ContextOtherExpression {
		return facts.ReasonNotStatement
	}
	if site.Op.Iterates() {
		if r := callbackReason(site.Callback); r != facts.ReasonNone {
			return r
		}
	}
	if len(site.Reasons) > 0 {
		return site.Reasons[0]
	}
	if site.Op != facts.OpEach || site.ArrayLiteral {
		return facts.ReasonOpNotRewritten
	}
	return facts.ReasonNone
}

// callbackReason returns the first reason callback cannot be transplanted,
// and facts.ReasonNone when it can be.
func callbackReason(callback *facts.Callback) facts.Reason {
	switch {
	case callback == nil:
		return facts.ReasonCallbackNotInline
	case callback.Async:
		return facts.ReasonCallbackAsync
	case callback.Generator:
		return facts.ReasonCallbackGenerator
	case callback.FirstParam == facts.ParamOther || callback.Params > 1 || len(callback.ParamRedeclarations) > 0:
		return facts.ReasonCallbackParams
	case len(callback.FunctionLocal) > 0:
		return facts.ReasonCallbackFunctionBindings
	default:
		return facts.ReasonNone
	}
}
