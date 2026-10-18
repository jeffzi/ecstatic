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
	// Detail is the recovered panic's message for an INTERNAL bail; empty
	// for every other reason.
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

// Plan decides the sites of one file, nested sites included, and returns one
// bail per site; no site is rewritten yet.
//
// The bails are in post-order: the sites of one level (the file's top level,
// or the nested sites of one callback) in ascending source offset, each one
// preceded by the bails of its own nested sites. A nested call's bail
// therefore comes before its enclosing call's, although the enclosing call
// starts first: an enclosing site is decided only once every site inside its
// callback is.
//
// A panic while deciding one site makes that site an INTERNAL bail carrying
// the panic's message; every other site is decided as usual.
func Plan(sites []facts.Site) []Bail {
	return appendBails(nil, sites, reason)
}

// appendBails appends the bails of sites and of their nested sites, in Plan's
// order, with decide choosing each site's reason; tests pass a decide that
// panics to exercise the INTERNAL bail.
func appendBails(bails []Bail, sites []facts.Site, decide func(facts.Site) facts.Reason) []Bail {
	bySource := slices.SortedStableFunc(slices.Values(sites), func(a, b facts.Site) int {
		return cmp.Compare(a.Pos.Offset, b.Pos.Offset)
	})
	for _, site := range bySource {
		bails = appendBails(bails, site.Nested, decide)
		bails = append(bails, decideSite(site, decide))
	}
	return bails
}

// decideSite returns the bail of site, an INTERNAL one when decide panics.
func decideSite(site facts.Site, decide func(facts.Site) facts.Reason) (bail Bail) {
	bail = Bail{Call: site.Call, Op: site.Op, Pos: site.Pos}
	defer func() {
		if recovered := recover(); recovered != nil {
			bail = bail.Internal(recovered)
		}
	}()
	bail.Reason = decide(site)
	return bail
}

// reason returns the first reason that applies to site, in this order:
// argument count, statement context, the callback of an iteration op, the
// first reason analysis recorded on site (whatever the reason and the op),
// and otherwise the op not being rewritten.
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
	return facts.ReasonOpNotRewritten
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
	case callback.FirstParam == facts.ParamOther || callback.Params > 1:
		return facts.ReasonCallbackParams
	case len(callback.FunctionLocal) > 0:
		return facts.ReasonCallbackFunctionBindings
	default:
		return facts.ReasonNone
	}
}
