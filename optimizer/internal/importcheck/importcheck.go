// Package importcheck enforces the module's package boundaries over the
// output of `go list -deps -json`.
package importcheck

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"
)

const (
	modulePath         = "github.com/jeffzi/ecstatic/optimizer"
	modulePrefix       = modulePath + "/"
	typeScriptGoModule = "github.com/microsoft/typescript-go"
	ttscModule         = "github.com/samchon/ttsc"

	checkerShim = typeScriptGoModule + "/shim/checker"
	ttscDriver  = ttscModule + "/packages/ttsc/driver"
)

const (
	factsPath       = "internal/facts"
	planPath        = "internal/plan"
	nodesPath       = "internal/nodes"
	analysisPath    = "internal/analysis"
	ttscadapterPath = "internal/ttscadapter"
	emitPath        = "internal/emit"
)

// Packages returns the import paths of the packages the rules name. A rule keyed on a path no
// package of the module has enforces nothing, so the module's own test confirms each one exists.
func Packages() []string {
	return []string{
		modulePrefix + factsPath,
		modulePrefix + planPath,
		modulePrefix + nodesPath,
		modulePrefix + analysisPath,
		modulePrefix + ttscadapterPath,
		modulePrefix + emitPath,
	}
}

// Rule names the boundary a Violation breaks.
type Rule uint8

// The boundaries between the module's packages.
const (
	// RulePureClosure: facts and plan depend on no typescript-go or ttsc
	// package, so plan never sees an AST node or the checker.
	RulePureClosure Rule = iota + 1
	// RuleNodesClosure: nodes does not depend on the checker shim.
	RuleNodesClosure
	// RuleCheckerImporter: only analysis imports the checker shim.
	RuleCheckerImporter
	// RuleDriverImporter: only ttscadapter imports the ttsc driver.
	RuleDriverImporter
	// RuleEmitClosure: emit depends on no checker shim and no ttsc package,
	// so it builds output from the AST and the plan alone.
	RuleEmitClosure
)

// String describes the boundary. A value that is not a declared rule, the zero value included,
// renders as Rule(N).
func (r Rule) String() string {
	switch r {
	case RulePureClosure:
		return "facts and plan must not depend on typescript-go or ttsc"
	case RuleNodesClosure:
		return "nodes must not depend on the checker shim"
	case RuleCheckerImporter:
		return "only analysis may import the checker shim"
	case RuleDriverImporter:
		return "only ttscadapter may import the ttsc driver"
	case RuleEmitClosure:
		return "emit must not depend on the checker shim or ttsc"
	default:
		return fmt.Sprintf("Rule(%d)", uint8(r))
	}
}

// Violation is one package breaking one boundary.
type Violation struct {
	Package string
	// Import is the offending direct import, or for a closure rule the
	// offending package anywhere in the dependency closure.
	Import string
	Rule   Rule
}

// Error names the package, the dependency, and the boundary between them.
func (v Violation) Error() string {
	return fmt.Sprintf("%s depends on %s: %s", v.Package, v.Import, v.Rule)
}

type listedPackage struct {
	ImportPath string
	Imports    []string
	Deps       []string
}

// Check reads the JSON stream `go list -deps -json` writes and returns every
// boundary violation among the module's packages, in stream order. Packages
// outside the module are never checked.
//
// It returns an error when the stream does not decode.
func Check(r io.Reader) ([]Violation, error) {
	var violations []Violation
	dec := json.NewDecoder(r)
	for {
		var pkg listedPackage
		err := dec.Decode(&pkg)
		if errors.Is(err, io.EOF) {
			return violations, nil
		}
		if err != nil {
			return nil, fmt.Errorf("decode go list output: %w", err)
		}
		violations = append(violations, checkPackage(pkg)...)
	}
}

func checkPackage(pkg listedPackage) []Violation {
	rel, ok := moduleRelative(pkg.ImportPath)
	if !ok {
		return nil
	}
	var violations []Violation
	report := func(imports []string, rule Rule, forbidden func(string) bool) {
		for _, imp := range imports {
			if forbidden(imp) {
				violations = append(violations, Violation{Package: pkg.ImportPath, Import: imp, Rule: rule})
			}
		}
	}
	isChecker := func(path string) bool { return path == checkerShim }
	isDriver := func(path string) bool { return path == ttscDriver }

	switch rel {
	case factsPath, planPath:
		report(pkg.Deps, RulePureClosure, isCompilerPackage)
	case nodesPath:
		report(pkg.Deps, RuleNodesClosure, isChecker)
	case emitPath:
		report(pkg.Deps, RuleEmitClosure, func(path string) bool { return isChecker(path) || inModule(path, ttscModule) })
	}
	if rel != analysisPath {
		report(pkg.Imports, RuleCheckerImporter, isChecker)
	}
	if rel != ttscadapterPath {
		report(pkg.Imports, RuleDriverImporter, isDriver)
	}
	return violations
}

func isCompilerPackage(path string) bool {
	return inModule(path, typeScriptGoModule) || inModule(path, ttscModule)
}

func inModule(path, module string) bool {
	return path == module || strings.HasPrefix(path, module+"/")
}

// moduleRelative returns importPath relative to the module root, empty for the root package
// itself, and false when importPath lies outside the module.
func moduleRelative(importPath string) (string, bool) {
	if importPath == modulePath {
		return "", true
	}
	return strings.CutPrefix(importPath, modulePrefix)
}
