package plan

import (
	"github.com/jeffzi/ecstatic/optimizer/internal/facts"
	_ "github.com/jeffzi/ecstatic/optimizer/internal/golden" // registers -update, which go test ./... -update passes to every test binary
)

// PlanWith plans sites as Plan does, with decide choosing each site's reason,
// so a test can make one site's planning panic.
func PlanWith(sites []facts.Site, decide func(facts.Site) facts.Reason) []Bail {
	return appendBails(nil, sites, decide)
}
