package analysis_test

import (
	"bytes"
	"cmp"
	"encoding/json"
	"errors"
	"fmt"
	"go/ast"
	"go/importer"
	"go/parser"
	"go/token"
	"go/types"
	"io"
	"maps"
	"os"
	"os/exec"
	"path/filepath"
	"runtime/debug"
	"slices"
	"strings"
	"testing"
)

const (
	symbolsFile        = "symbols.go"
	probeFile          = "probe.go"
	shimASTPackage     = "github.com/microsoft/typescript-go/shim/ast"
	shimCheckerPackage = "github.com/microsoft/typescript-go/shim/checker"
)

// parsedPackage is the analysis package's non-test files, parsed.
type parsedPackage struct {
	fileSet *token.FileSet
	files   map[string]*ast.File
}

// parsePackage parses the package's non-test .go files plus overlay, a map from file name to source.
func parsePackage(t *testing.T, overlay map[string]string) parsedPackage {
	t.Helper()
	entries, err := os.ReadDir(".")
	if err != nil {
		t.Fatalf("read package directory: %v", err)
	}
	pkg := parsedPackage{fileSet: token.NewFileSet(), files: map[string]*ast.File{}}
	for _, entry := range entries {
		name := entry.Name()
		if !strings.HasSuffix(name, ".go") || strings.HasSuffix(name, "_test.go") {
			continue
		}
		pkg.parse(t, name, nil)
	}
	if len(pkg.files) == 0 {
		t.Fatal("found no non-test .go files in the analysis package")
	}
	for name, source := range overlay {
		pkg.parse(t, name, source)
	}
	return pkg
}

// parse adds the file name, read from disk when source is nil.
func (p parsedPackage) parse(t *testing.T, name string, source any) {
	t.Helper()
	file, err := parser.ParseFile(p.fileSet, name, source, parser.SkipObjectResolution)
	if err != nil {
		t.Fatalf("parse %s: %v", name, err)
	}
	p.files[name] = file
}

// listedExports is the analysis package as `go list -export` reports it.
type listedExports struct {
	// files maps every package the analysis package depends on to its compiled export data file.
	files map[string]string
	// path is the analysis package's own import path.
	path string
}

// testBuildFlags returns the compile flags the test binary was built with, so a go list -export
// reuses the cached compile of the dependencies instead of compiling them again with other flags.
func testBuildFlags(t *testing.T) []string {
	t.Helper()
	compileFlags := []string{"-race", "-msan", "-asan", "-tags", "-gcflags", "-trimpath"}
	info, ok := debug.ReadBuildInfo()
	if !ok {
		t.Fatal("the test binary carries no build info")
	}
	var flags []string
	for _, setting := range info.Settings {
		if slices.Contains(compileFlags, setting.Key) {
			flags = append(flags, setting.Key+"="+setting.Value)
		}
	}
	return flags
}

// exportData lists the analysis package and the export data of its dependencies.
func exportData(t *testing.T) listedExports {
	t.Helper()
	args := append([]string{"list"}, testBuildFlags(t)...)
	args = append(args, "-export", "-deps", "-json=ImportPath,Export,DepOnly", ".")
	cmd := exec.CommandContext(t.Context(), "go", args...) //nolint:gosec // the arguments are literals plus the test binary's own build settings
	out, err := cmd.Output()
	if err != nil {
		t.Fatalf("go list -export: %v", err)
	}
	exports := listedExports{files: map[string]string{}}
	decoder := json.NewDecoder(bytes.NewReader(out))
	for {
		var listed struct {
			ImportPath string
			Export     string
			DepOnly    bool
		}
		err := decoder.Decode(&listed)
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			t.Fatalf("decode go list output: %v", err)
		}
		if !listed.DepOnly {
			exports.path = listed.ImportPath
		}
		exports.files[listed.ImportPath] = listed.Export
	}
	if exports.path == "" {
		t.Fatal("go list -export listed only dependencies, want the analysis package itself")
	}
	return exports
}

// memberUse is a field or method selected on a compiler type outside symbols.go.
type memberUse struct {
	file   string
	member string
	pos    token.Position
}

// checkedPackage is the analysis package type-checked against the compiled
// export data of its dependencies.
type checkedPackage struct {
	fileSet    *token.FileSet
	selections map[*ast.SelectorExpr]*types.Selection
	importer   types.Importer
}

// typeCheck type-checks pkg against exports, failing the test on a type error.
func typeCheck(t *testing.T, pkg parsedPackage, exports listedExports) checkedPackage {
	t.Helper()
	lookup := func(path string) (io.ReadCloser, error) {
		file, ok := exports.files[path]
		if !ok || file == "" {
			return nil, fmt.Errorf("no export data for %s", path)
		}
		return os.DirFS(filepath.Dir(file)).Open(filepath.Base(file))
	}
	compiled := importer.ForCompiler(pkg.fileSet, "gc", lookup)
	config := types.Config{Importer: compiled}
	info := &types.Info{Selections: map[*ast.SelectorExpr]*types.Selection{}}
	files := make([]*ast.File, 0, len(pkg.files))
	for _, name := range slices.Sorted(maps.Keys(pkg.files)) {
		files = append(files, pkg.files[name])
	}
	if _, err := config.Check(exports.path, pkg.fileSet, files, info); err != nil {
		t.Fatalf("type-check the analysis package: %v", err)
	}
	return checkedPackage{fileSet: pkg.fileSet, selections: info.Selections, importer: compiled}
}

// compilerType returns the type the compiler package at path declares as name,
// from the same import the type-check resolved.
func (p checkedPackage) compilerType(t *testing.T, path, name string) types.Type {
	t.Helper()
	imported, err := p.importer.Import(path)
	if err != nil {
		t.Fatalf("import %s: %v", path, err)
	}
	typeName, ok := imported.Scope().Lookup(name).(*types.TypeName)
	if !ok {
		t.Fatalf("%s declares no type %s", path, name)
	}
	return typeName.Type()
}

// usesOutsideSymbolsFile lists, in file and offset order, the selections
// outside symbols.go that flagged reports.
func (p checkedPackage) usesOutsideSymbolsFile(flagged func(*ast.SelectorExpr, *types.Selection) bool) []memberUse {
	var uses []memberUse
	for sel, selection := range p.selections {
		pos := p.fileSet.Position(sel.Pos())
		if pos.Filename != symbolsFile && flagged(sel, selection) {
			uses = append(uses, memberUse{file: pos.Filename, member: sel.Sel.Name, pos: pos})
		}
	}
	slices.SortFunc(uses, func(a, b memberUse) int {
		return cmp.Or(strings.Compare(a.file, b.file), cmp.Compare(a.pos.Offset, b.pos.Offset))
	})
	return uses
}

// symbolMemberUses type-checks pkg against exports and lists the selections of
// a field or method on the compiler's ast.Symbol outside symbols.go.
func symbolMemberUses(t *testing.T, pkg parsedPackage, exports listedExports) []memberUse {
	t.Helper()
	checked := typeCheck(t, pkg, exports)
	symbol := checked.compilerType(t, shimASTPackage, "Symbol")
	return checked.usesOutsideSymbolsFile(func(_ *ast.SelectorExpr, selection *types.Selection) bool {
		return isType(selection.Recv(), symbol)
	})
}

// symbolAccessorUses type-checks pkg against exports and lists the calls
// outside symbols.go of a symbol or file-name accessor: a method of the
// compiler's *checker.Checker, *checker.Type, or *ast.SourceFile whose
// signature takes or returns an *ast.Symbol, and SourceFile.FileName. These
// are the accessors a compiler upgrade may rename.
func symbolAccessorUses(t *testing.T, pkg parsedPackage, exports listedExports) []memberUse {
	t.Helper()
	checked := typeCheck(t, pkg, exports)
	symbol := checked.compilerType(t, shimASTPackage, "Symbol")
	sourceFile := checked.compilerType(t, shimASTPackage, "SourceFile")
	receivers := []types.Type{
		checked.compilerType(t, shimCheckerPackage, "Checker"),
		checked.compilerType(t, shimCheckerPackage, "Type"),
		sourceFile,
	}
	return checked.usesOutsideSymbolsFile(func(sel *ast.SelectorExpr, selection *types.Selection) bool {
		if selection.Kind() != types.MethodVal {
			return false
		}
		if !slices.ContainsFunc(receivers, func(receiver types.Type) bool { return isType(selection.Recv(), receiver) }) {
			return false
		}
		if isType(selection.Recv(), sourceFile) && sel.Sel.Name == "FileName" {
			return true
		}
		signature, ok := selection.Type().(*types.Signature)
		return ok && (mentionsType(signature.Params(), symbol) || mentionsType(signature.Results(), symbol))
	})
}

// mentionsType reports whether a variable of vars has type want, a pointer to
// it, or a slice of either.
func mentionsType(vars *types.Tuple, want types.Type) bool {
	for v := range vars.Variables() {
		typ := v.Type()
		if slice, ok := typ.(*types.Slice); ok {
			typ = slice.Elem()
		}
		if isType(typ, want) {
			return true
		}
	}
	return false
}

// isType reports whether typ is want or a pointer to it.
func isType(typ, want types.Type) bool {
	if pointer, ok := typ.(*types.Pointer); ok {
		typ = pointer.Elem()
	}
	return types.Identical(typ, want)
}

// membersIn lists the members of the uses recorded in file.
func membersIn(uses []memberUse, file string) []string {
	var got []string
	for _, use := range uses {
		if use.file == file {
			got = append(got, use.member)
		}
	}
	return got
}

func TestAnalysisPackage_CallsSymbolAccessorsOnlyFromSymbolsFile(t *testing.T) {
	t.Parallel()
	pkg := parsePackage(t, nil)
	exports := exportData(t)

	got := symbolAccessorUses(t, pkg, exports)

	for _, use := range got {
		t.Errorf("%s calls accessor %s, want it confined to %s", use.pos, use.member, symbolsFile)
	}
}

func TestAnalysisPackage_UsesSymbolMembersOnlyFromSymbolsFile(t *testing.T) {
	t.Parallel()
	pkg := parsePackage(t, nil)
	exports := exportData(t)

	got := symbolMemberUses(t, pkg, exports)

	if len(got) != 0 {
		t.Errorf("symbol members used outside %s = %+v, want none", symbolsFile, got)
	}
}

func TestSymbolMemberUses_FlagsOnlySelectionsOnASymbol(t *testing.T) {
	t.Parallel()
	exports := exportData(t)
	tests := []struct {
		name   string
		source string
		want   []string
	}{
		{
			name:   "symbol name field",
			source: "func probe(sym *ast.Symbol) string { return sym.Name }",
			want:   []string{"Name"},
		},
		{
			name:   "symbol flags field",
			source: "func probe(sym *ast.Symbol) ast.SymbolFlags { return sym.Flags }",
			want:   []string{"Flags"},
		},
		{
			name: "name selectors on a node and a struct",
			source: `type manifest struct{ Name string }

func probe(m manifest, callee *ast.Node) string {
	_ = callee.Name()
	return m.Name
}`,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			source := "package analysis\n\nimport \"" + shimASTPackage + "\"\n\n" + tt.source + "\n"
			pkg := parsePackage(t, map[string]string{probeFile: source})

			uses := symbolMemberUses(t, pkg, exports)

			got := membersIn(uses, probeFile)
			if !slices.Equal(got, tt.want) {
				t.Errorf("symbol members flagged in %s = %v, want %v", probeFile, got, tt.want)
			}
		})
	}
}

func TestSymbolAccessorUses_FlagsOnlySymbolAndFileNameAccessors(t *testing.T) {
	t.Parallel()
	exports := exportData(t)
	tests := []struct {
		name   string
		source string
		want   []string
	}{
		{
			name:   "checker method taking a symbol",
			source: "func probe(c *checker.Checker, sym *ast.Symbol) *checker.Type { return c.GetDeclaredTypeOfSymbol(sym) }",
			want:   []string{"GetDeclaredTypeOfSymbol"},
		},
		{
			name:   "type method returning a symbol",
			source: "func probe(_ *checker.Checker, t *checker.Type) *ast.Symbol { return t.Symbol() }",
			want:   []string{"Symbol"},
		},
		{
			name:   "source file name",
			source: "func probe(_ *checker.Checker, file *ast.SourceFile) string { return file.FileName() }",
			want:   []string{"FileName"},
		},
		{
			name:   "checker method free of symbols",
			source: "func probe(c *checker.Checker, node *ast.Node) *checker.Type { return c.GetTypeAtLocation(node) }",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			source := "package analysis\n\nimport (\n\t\"" + shimASTPackage + "\"\n\t\"" + shimCheckerPackage + "\"\n)\n\n" + tt.source + "\n"
			pkg := parsePackage(t, map[string]string{probeFile: source})

			uses := symbolAccessorUses(t, pkg, exports)

			got := membersIn(uses, probeFile)
			if !slices.Equal(got, tt.want) {
				t.Errorf("accessors flagged in %s = %v, want %v", probeFile, got, tt.want)
			}
		})
	}
}
