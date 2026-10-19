package importcheck_test

import (
	"bytes"
	"encoding/json"
	"slices"
	"strings"
	"testing"

	"github.com/google/go-cmp/cmp"
	"github.com/google/go-cmp/cmp/cmpopts"

	_ "github.com/jeffzi/ecstatic/optimizer/internal/golden" // registers -update, which go test ./... -update passes to every test binary
	"github.com/jeffzi/ecstatic/optimizer/internal/importcheck"
)

const (
	module   = "github.com/jeffzi/ecstatic/optimizer"
	shimAST  = "github.com/microsoft/typescript-go/shim/ast"
	shimCore = "github.com/microsoft/typescript-go/shim/core"
	checker  = "github.com/microsoft/typescript-go/shim/checker"
	tsgoAST  = "github.com/microsoft/typescript-go/internal/ast"
	tsgoRoot = "github.com/microsoft/typescript-go"
	// lookalike shares the typescript-go module path as a string prefix but is another module.
	lookalike   = "github.com/microsoft/typescript-go-extra/fmt"
	compiler    = "github.com/microsoft/typescript-go/shim/compiler"
	shimPrinter = "github.com/microsoft/typescript-go/shim/printer"
	ttscCmd     = "github.com/samchon/ttsc/packages/ttsc/cmd/ttsc"
	driver      = "github.com/samchon/ttsc/packages/ttsc/driver"
	// ttscUtility is a ttsc package other than the driver.
	ttscUtility = "github.com/samchon/ttsc/packages/ttsc/utility"
)

const (
	factsPkg       = module + "/internal/facts"
	planPkg        = module + "/internal/plan"
	nodesPkg       = module + "/internal/nodes"
	analysisPkg    = module + "/internal/analysis"
	ttscadapterPkg = module + "/internal/ttscadapter"
	emitPkg        = module + "/internal/emit"
)

// Module-root paths that are not the packages' internal/ paths. The rules name a package by its
// internal/ path, so a package at one of these paths gets no importer exemption: it may not import
// the checker shim or the ttsc driver.
const (
	rootAnalysisPkg    = module + "/analysis"
	rootTtscadapterPkg = module + "/ttscadapter"
)

type listedPackage struct {
	ImportPath string
	Imports    []string `json:",omitempty"`
	Deps       []string `json:",omitempty"`
}

// goList renders packages the way `go list -deps -json` streams them.
func goList(t *testing.T, packages ...listedPackage) *bytes.Buffer {
	t.Helper()
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetIndent("", "\t")
	for _, p := range packages {
		if err := enc.Encode(p); err != nil {
			t.Fatalf("encode %s: %v", p.ImportPath, err)
		}
	}
	return &buf
}

// check runs Check over the listed packages, failing the test on an error.
func check(t *testing.T, packages ...listedPackage) []importcheck.Violation {
	t.Helper()
	got, err := importcheck.Check(goList(t, packages...))
	if err != nil {
		t.Fatalf("Check() error = %v, want nil", err)
	}
	return got
}

type violationCase struct {
	name string
	pkg  listedPackage
	want []importcheck.Violation
}

// pureAndNodesClosureCases holds facts, plan, and nodes each depending on a package its closure rule forbids.
func pureAndNodesClosureCases() []violationCase {
	return []violationCase{
		{
			name: "facts depends on typescript-go",
			pkg: listedPackage{
				ImportPath: factsPkg,
				Imports:    []string{"strings"},
				Deps:       []string{shimCore, "strings"},
			},
			want: []importcheck.Violation{{Package: factsPkg, Import: shimCore, Rule: importcheck.RulePureClosure}},
		},
		{
			name: "plan depends on ttsc",
			pkg: listedPackage{
				ImportPath: planPkg,
				Imports:    []string{factsPkg},
				Deps:       []string{factsPkg, driver},
			},
			want: []importcheck.Violation{{Package: planPkg, Import: driver, Rule: importcheck.RulePureClosure}},
		},
		{
			name: "nodes depends on the checker shim",
			pkg: listedPackage{
				ImportPath: nodesPkg,
				Imports:    []string{shimAST},
				Deps:       []string{checker, shimAST},
			},
			want: []importcheck.Violation{{Package: nodesPkg, Import: checker, Rule: importcheck.RuleNodesClosure}},
		},
	}
}

// emitClosureCases holds emit depending on a package its closure rule forbids.
func emitClosureCases() []violationCase {
	return []violationCase{
		{
			name: "emit depends on the checker shim",
			pkg: listedPackage{
				ImportPath: emitPkg,
				Imports:    []string{shimAST},
				Deps:       []string{checker, shimAST},
			},
			want: []importcheck.Violation{{Package: emitPkg, Import: checker, Rule: importcheck.RuleEmitClosure}},
		},
		{
			name: "emit depends on a ttsc package other than the driver",
			pkg: listedPackage{
				ImportPath: emitPkg,
				Imports:    []string{shimPrinter},
				Deps:       []string{shimPrinter, ttscUtility},
			},
			want: []importcheck.Violation{{Package: emitPkg, Import: ttscUtility, Rule: importcheck.RuleEmitClosure}},
		},
	}
}

// importerCases holds the module root, which no importer rule exempts, importing the ttsc driver.
func importerCases() []violationCase {
	return []violationCase{
		{
			name: "the module root imports the ttsc driver",
			pkg: listedPackage{
				ImportPath: module,
				Imports:    []string{driver},
				Deps:       []string{driver},
			},
			want: []importcheck.Violation{{Package: module, Import: driver, Rule: importcheck.RuleDriverImporter}},
		},
	}
}

// closureModuleCases holds a closure-rule package depending on a compiler module's root path itself.
func closureModuleCases() []violationCase {
	return []violationCase{
		{
			name: "facts depends on the typescript-go module root",
			pkg:  listedPackage{ImportPath: factsPkg, Imports: []string{"strings"}, Deps: []string{tsgoRoot, "strings"}},
			want: []importcheck.Violation{{Package: factsPkg, Import: tsgoRoot, Rule: importcheck.RulePureClosure}},
		},
	}
}

// nearExemptPathCases holds packages beside an exempt path, but not at it, breaking an importer rule.
func nearExemptPathCases() []violationCase {
	return []violationCase{
		{
			name: "analysis at the old root path imports the checker shim",
			pkg: listedPackage{
				ImportPath: rootAnalysisPkg,
				Imports:    []string{checker},
				Deps:       []string{checker},
			},
			want: []importcheck.Violation{{Package: rootAnalysisPkg, Import: checker, Rule: importcheck.RuleCheckerImporter}},
		},
		{
			name: "ttscadapter at the old root path imports the ttsc driver",
			pkg: listedPackage{
				ImportPath: rootTtscadapterPkg,
				Imports:    []string{driver},
				Deps:       []string{driver},
			},
			want: []importcheck.Violation{{Package: rootTtscadapterPkg, Import: driver, Rule: importcheck.RuleDriverImporter}},
		},
	}
}

// doubleViolationCases holds a closure-rule package that also imports the checker shim directly.
func doubleViolationCases() []violationCase {
	return []violationCase{
		{
			name: "a closure-rule package importing the checker shim breaks both rules",
			pkg:  listedPackage{ImportPath: factsPkg, Imports: []string{checker}, Deps: []string{checker}},
			want: []importcheck.Violation{
				{Package: factsPkg, Import: checker, Rule: importcheck.RulePureClosure},
				{Package: factsPkg, Import: checker, Rule: importcheck.RuleCheckerImporter},
			},
		},
	}
}

func TestCheck(t *testing.T) {
	t.Parallel()
	byRule := cmpopts.SortSlices(func(a, b importcheck.Violation) bool { return a.Rule < b.Rule })
	cases := slices.Concat(pureAndNodesClosureCases(), emitClosureCases(), importerCases(), closureModuleCases(), nearExemptPathCases(), doubleViolationCases())
	for _, tt := range cases {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()

			got := check(t, tt.pkg)

			if diff := cmp.Diff(tt.want, got, byRule); diff != "" {
				t.Errorf("Check() mismatch (-want +got):\n%s", diff)
			}
		})
	}
}

func TestCheck_WhenGraphRespectsBoundaries_ReportsNothing(t *testing.T) {
	t.Parallel()
	got := check(t,
		listedPackage{ImportPath: "strings"},
		listedPackage{ImportPath: factsPkg, Imports: []string{"strings"}, Deps: []string{lookalike, "strings"}},
		listedPackage{
			ImportPath: planPkg,
			Imports:    []string{factsPkg},
			Deps:       []string{factsPkg, "strings"},
		},
		listedPackage{ImportPath: nodesPkg, Imports: []string{shimAST}, Deps: []string{shimAST, tsgoAST}},
		listedPackage{ImportPath: analysisPkg, Imports: []string{checker}, Deps: []string{checker, tsgoAST}},
		listedPackage{
			ImportPath: emitPkg,
			Imports:    []string{shimAST, shimPrinter, nodesPkg, planPkg},
			Deps:       []string{factsPkg, nodesPkg, planPkg, shimAST, shimPrinter, tsgoAST},
		},
		listedPackage{ImportPath: ttscadapterPkg, Imports: []string{driver}, Deps: []string{checker, driver}},
		listedPackage{ImportPath: module, Imports: []string{ttscadapterPkg}, Deps: []string{checker, driver, ttscadapterPkg}},
		listedPackage{ImportPath: compiler, Imports: []string{checker}, Deps: []string{checker}},
		listedPackage{ImportPath: ttscCmd, Imports: []string{driver}, Deps: []string{driver}},
	)

	if len(got) != 0 {
		t.Errorf("Check() = %+v, want no violations", got)
	}
}

func TestPackages_WhenComparedWithTheRules_NamesEveryPackageOneIsKeyedOn(t *testing.T) {
	t.Parallel()
	want := []string{factsPkg, planPkg, nodesPkg, analysisPkg, ttscadapterPkg, emitPkg}

	got := importcheck.Packages()

	byName := cmpopts.SortSlices(func(a, b string) bool { return a < b })
	if diff := cmp.Diff(want, got, byName); diff != "" {
		t.Errorf("Packages() mismatch (-want +got):\n%s", diff)
	}
}

func TestCheck_WhenOutputIsMalformed_ReturnsError(t *testing.T) {
	t.Parallel()

	_, err := importcheck.Check(strings.NewReader(`{"ImportPath": `))

	if err == nil {
		t.Error("Check(truncated JSON) error = nil, want a decode error")
	}
}

func TestRule_String_WhenRuleIsUndeclared_RendersRuleN(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name string
		want string
		rule importcheck.Rule
	}{
		{name: "zero value", rule: importcheck.Rule(0), want: "Rule(0)"},
		{name: "one past the last rule", rule: importcheck.Rule(6), want: "Rule(6)"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()

			got := tt.rule.String()

			if got != tt.want {
				t.Errorf("Rule(%d).String() = %q, want %q", uint8(tt.rule), got, tt.want)
			}
		})
	}
}

func TestViolation_Error(t *testing.T) {
	t.Parallel()
	tests := []struct {
		boundary string
		rule     importcheck.Rule
	}{
		{rule: importcheck.RulePureClosure, boundary: "facts and plan must not depend on typescript-go or ttsc"},
		{rule: importcheck.RuleNodesClosure, boundary: "nodes must not depend on the checker shim"},
		{rule: importcheck.RuleCheckerImporter, boundary: "only analysis may import the checker shim"},
		{rule: importcheck.RuleDriverImporter, boundary: "only ttscadapter may import the ttsc driver"},
		{rule: importcheck.RuleEmitClosure, boundary: "emit must not depend on the checker shim or ttsc"},
	}
	for _, tt := range tests {
		v := importcheck.Violation{Package: emitPkg, Import: checker, Rule: tt.rule}
		t.Run(tt.boundary, func(t *testing.T) {
			t.Parallel()

			msg := v.Error()

			for _, part := range []string{v.Package, v.Import, tt.boundary} {
				if !strings.Contains(msg, part) {
					t.Errorf("Violation.Error() = %q, want it to contain %q", msg, part)
				}
			}
		})
	}
}
