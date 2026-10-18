package analysis

import (
	"encoding/json"
	"io/fs"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"

	"github.com/microsoft/typescript-go/shim/ast"
	"github.com/microsoft/typescript-go/shim/checker"
	"github.com/microsoft/typescript-go/shim/scanner"

	"github.com/jeffzi/ecstatic/optimizer/internal/facts"
	"github.com/jeffzi/ecstatic/optimizer/internal/nodes"
)

// Analyze reports the ecstatic call sites of file in source order, with the
// node table their NodeIDs index. A site found inside the inline callback of
// an each or query call is listed in that site's Nested, not at the top
// level. A file inside an ecstatic package's runtime (its src/ or dist/)
// yields no sites, so the runtime never rewrites its own calls.
func Analyze(c *checker.Checker, file *ast.SourceFile, roots *PackageRoots) ([]facts.Site, *nodes.Table) {
	table := nodes.NewTable()
	if roots.inRuntime(sourceFileName(file)) {
		return nil, table
	}
	w := walker{checker: c, roots: roots, table: table, file: file}
	return w.collect(file.AsNode(), nil), table
}

type walker struct {
	checker *checker.Checker
	roots   *PackageRoots
	table   *nodes.Table
	file    *ast.SourceFile
}

// collect appends the sites in node's subtree to sites, in source order.
func (w *walker) collect(node *ast.Node, sites []facts.Site) []facts.Site {
	if node.Kind == ast.KindCallExpression {
		if op, ok := recognize(w.checker, w.roots, node); ok {
			return w.collectSite(node, op, sites)
		}
	}
	node.ForEachChild(func(child *ast.Node) bool {
		sites = w.collect(child, sites)
		return false
	})
	return sites
}

// collectSite appends the site of call, then the sites in its operands. Sites
// in an iteration callback become the call's nested sites; any other operand's
// sites follow the call's own at the same level.
func (w *walker) collectSite(call *ast.Node, op facts.Op, sites []facts.Site) []facts.Site {
	site := facts.Site{
		Call:    w.table.Register(call),
		Op:      op,
		Context: statementContext(call),
		Pos:     w.position(call),
	}
	switch {
	case op.Iterates() && !op.MatchesArgCount(len(call.Arguments())):
		// The call already stays a runtime call, so its shape is never needed.
		site.Reasons = append(site.Reasons, facts.ReasonArgCount)
	case op == facts.OpEach:
		resolveShapes(w.checker, &site, call.Arguments()[0])
	}
	callback := inlineCallback(call, op)
	if callback != nil {
		site.Callback = summarizeCallback(w.checker, w.table, callback)
	}
	index := len(sites)
	sites = append(sites, site)
	var nested []facts.Site
	call.ForEachChild(func(child *ast.Node) bool {
		if child == callback {
			nested = w.collect(child, nested)
		} else {
			sites = w.collect(child, sites)
		}
		return false
	})
	sites[index].Nested = nested
	return sites
}

// position locates the first token of call, leading trivia excluded. The
// column counts UTF-16 code units, as TypeScript's own diagnostics do.
func (w *walker) position(call *ast.Node) facts.Position {
	offset := scanner.GetTokenPosOfNode(call, w.file, false)
	line, character := scanner.GetECMALineAndUTF16CharacterOfPosition(w.file, offset)
	return facts.Position{
		File:   sourceFileName(w.file),
		Offset: offset,
		Line:   line + 1,
		Column: int(character) + 1,
	}
}

// inlineCallback returns the function written as the last argument of an
// iteration call, nil when there is none or op does not iterate.
func inlineCallback(call *ast.Node, op facts.Op) *ast.Node {
	args := call.Arguments()
	if !op.Iterates() || len(args) == 0 {
		return nil
	}
	last := args[len(args)-1]
	if last.Kind != ast.KindArrowFunction && last.Kind != ast.KindFunctionExpression {
		return nil
	}
	return last
}

func statementContext(call *ast.Node) facts.StmtContext {
	parent := call.Parent
	switch {
	case parent.Kind == ast.KindExpressionStatement:
		return facts.ContextExpressionStatement
	case parent.Kind == ast.KindArrowFunction && parent.Body() == call:
		return facts.ContextArrowBody
	default:
		return facts.ContextOtherExpression
	}
}

// recognize returns the op call invokes, and false when its callee does not
// resolve to a function an ecstatic package's runtime declares. A callee
// reached through a variable (`const myEach = each`) resolves to that
// variable, which no runtime declares, so the call stays a runtime call.
func recognize(c *checker.Checker, roots *PackageRoots, call *ast.Node) (facts.Op, bool) {
	name := calleeName(call)
	if name == nil {
		return facts.OpNone, false
	}
	symbol := resolveSymbol(c, name)
	if symbol == nil {
		return facts.OpNone, false
	}
	if !slices.ContainsFunc(declarationFileNames(symbol), roots.inRuntime) {
		return facts.OpNone, false
	}
	return facts.OpByName(symbolName(symbol))
}

// calleeName returns the identifier naming call's callee: the callee itself
// (`each(...)`) or the property of a namespace access (`ecs.each(...)`); nil
// for any other callee shape.
func calleeName(call *ast.Node) *ast.Node {
	callee := call.Expression()
	switch callee.Kind {
	case ast.KindIdentifier:
		return callee
	case ast.KindPropertyAccessExpression:
		return callee.Name()
	default:
		return nil
	}
}

// PackageRoots finds ecstatic package roots: the directories whose
// package.json is named "ecstatic". It caches each directory's answer, so one
// value should serve a whole run. It is safe for concurrent use.
type PackageRoots struct {
	byDir map[string]packageRoot
	mu    sync.Mutex
}

type packageRoot struct {
	dir   string
	found bool
}

// NewPackageRoots returns an empty root cache.
func NewPackageRoots() *PackageRoots {
	return &PackageRoots{byDir: map[string]packageRoot{}}
}

// Root returns the nearest ancestor directory of fileName that is an ecstatic
// package root, and false when no ancestor is one. A package.json that is
// missing, unreadable, not valid JSON, or named otherwise does not make its
// directory a root; the search continues upward past it.
func (r *PackageRoots) Root(fileName string) (string, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	root := r.rootOf(filepath.Dir(filepath.FromSlash(fileName)))
	return root.dir, root.found
}

func (r *PackageRoots) rootOf(dir string) packageRoot {
	if root, ok := r.byDir[dir]; ok {
		return root
	}
	var root packageRoot
	if isEcstaticPackage(dir) {
		root = packageRoot{dir: dir, found: true}
	} else if parent := filepath.Dir(dir); parent != dir {
		root = r.rootOf(parent)
	}
	r.byDir[dir] = root
	return root
}

// inRuntime reports whether fileName lies in an ecstatic package's runtime:
// the src/ or dist/ directory of its root. Rooting the test at those two
// directories keeps out the root's own dependencies, which for the ecstatic
// repository sit in node_modules/ under the same root.
func (r *PackageRoots) inRuntime(fileName string) bool {
	path := filepath.FromSlash(fileName)
	root, ok := r.Root(path)
	if !ok {
		return false
	}
	separator := string(filepath.Separator)
	top, _, _ := strings.Cut(strings.TrimPrefix(path, root+separator), separator)
	return top == "src" || top == "dist"
}

// isEcstaticPackage reports whether dir holds a package.json named
// "ecstatic". A package.json that cannot be read or decoded is, by the
// definition of a root, not one, so its error is the answer rather than a
// failure.
func isEcstaticPackage(dir string) bool {
	data, err := fs.ReadFile(os.DirFS(dir), "package.json")
	if err != nil {
		return false
	}
	var manifest struct {
		Name string `json:"name"`
	}
	if err := json.Unmarshal(data, &manifest); err != nil {
		return false
	}
	return manifest.Name == "ecstatic"
}
