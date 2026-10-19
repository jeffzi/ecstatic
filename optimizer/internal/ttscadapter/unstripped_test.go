package ttscadapter_test

import (
	"encoding/json"
	"fmt"
	"maps"
	"path"
	"path/filepath"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"testing"

	"github.com/google/go-cmp/cmp"
	"github.com/microsoft/typescript-go/shim/ast"
	"github.com/microsoft/typescript-go/shim/core"
	"github.com/microsoft/typescript-go/shim/parser"
	"github.com/microsoft/typescript-go/shim/scanner"

	"github.com/jeffzi/ecstatic/optimizer/internal/printed"
	"github.com/jeffzi/ecstatic/optimizer/internal/project"
)

// testsRoot is the repository's tests directory, relative to this package.
const testsRoot = "../../../tests"

// optimizerTsconfig is the project under testsRoot that the optimized unit runs transform.
const optimizerTsconfig = "tsconfig.optimizer.json"

// descriptorName is the name the descriptor in src/plugin/optimizer.ts declares, which ttsc passes the sidecar beside
// every plugin entry it loaded from that descriptor.
const descriptorName = "ecstatic"

// internalEntry is the module the emitter imports the shape guard's namespace from.
const internalEntry = "ecstatic/internal"

// shapeGuardName is the export of internalEntry that a shape guard calls.
const shapeGuardName = "assertShape"

// debugCopy matches the names the emitter gives a file's DEBUG copy: DEBUG, or DEBUG_<n> when the file already binds
// DEBUG.
var debugCopy = regexp.MustCompile(`^DEBUG(_[1-9][0-9]*)?$`)

// noGuards is the problem reported when no output holds a shape guard, so that the check cannot pass vacuously.
const noGuards = "no test module's output holds a shape guard, so the check has nothing to check"

// gate is one identifier whose truth an && expression requires before its right operand runs, and whether a binding
// of a function, block, catch clause, class, or for statement around the expression declares it there, so that it
// does not name the file's top-level binding.
type gate struct {
	name  string
	local bool
}

// String is the gate's name, marked when a local binding declares it.
func (g gate) String() string {
	if g.local {
		return g.name + " (a local binding)"
	}
	return g.name
}

// guard is one shape guard in a file's output: where it starts, and the gates the && expressions around it require
// before it runs, outermost first.
type guard struct {
	gates []gate
	pos   int
}

// guardImports are the local names through which a file calls internalEntry's shape guard: the namespaces it imports
// internalEntry as, and the names it imports the guard under.
type guardImports struct {
	namespaces map[string]bool
	functions  map[string]bool
}

// guardWalk is what collectGuards reads and gathers while it walks one file.
type guardWalk struct {
	imports guardImports
	guards  []guard
}

// scope is the names one function, block, catch clause, class, or for statement binds, inside the scopes around it.
// The file's top level is no scope, so a nil scope binds nothing.
type scope struct {
	outer *scope
	names map[string]bool
}

// binds reports whether s, or a scope around it, binds name.
func (s *scope) binds(name string) bool {
	for ; s != nil; s = s.outer {
		if s.names[name] {
			return true
		}
	}
	return false
}

// enter is the scope node's children run in: s with the scope node opens inside it, or s itself when node binds no
// name for its children.
func (s *scope) enter(node *ast.Node) *scope {
	names := map[string]bool{}
	scopeBindings(node, names)
	if len(names) == 0 {
		return s
	}
	return &scope{outer: s, names: names}
}

// isClass reports whether node is a class declaration or a class expression.
func isClass(node *ast.Node) bool {
	return node.Kind == ast.KindClassDeclaration || node.Kind == ast.KindClassExpression
}

// bindingNames adds to names every identifier name, an identifier or a destructuring pattern, binds.
func bindingNames(name *ast.Node, names map[string]bool) {
	switch {
	case name == nil:
	case name.Kind == ast.KindIdentifier:
		names[name.Text()] = true
	case ast.IsBindingPattern(name):
		for _, element := range name.Elements() {
			if element.Kind == ast.KindBindingElement {
				bindingNames(element.Name(), names)
			}
		}
	}
}

// declarationListNames adds to names every name list, a variable declaration list, binds when blockScoped is whether
// it is a let, const, or using list; any other list or node adds nothing.
func declarationListNames(list *ast.Node, blockScoped bool, names map[string]bool) {
	if list == nil || list.Kind != ast.KindVariableDeclarationList || (list.Flags&ast.NodeFlagsBlockScoped != 0) != blockScoped {
		return
	}
	for _, declaration := range list.AsVariableDeclarationList().Declarations.Nodes {
		bindingNames(declaration.Name(), names)
	}
}

// hoistedVars adds to names every name a var declaration in node binds, leaving out the functions and classes inside
// it, whose var declarations stay theirs.
func hoistedVars(node *ast.Node, names map[string]bool) {
	declarationListNames(node, false, names)
	node.ForEachChild(func(child *ast.Node) bool {
		if !ast.IsFunctionLike(child) && !isClass(child) {
			hoistedVars(child, names)
		}
		return false
	})
}

// lexicalBindings adds to names every name statements, the statements of one block, declare for that block alone.
func lexicalBindings(statements []*ast.Node, names map[string]bool) {
	for _, statement := range statements {
		switch statement.Kind {
		case ast.KindVariableStatement:
			declarationListNames(statement.AsVariableStatement().DeclarationList, true, names)
		case ast.KindFunctionDeclaration, ast.KindClassDeclaration, ast.KindEnumDeclaration, ast.KindModuleDeclaration:
			if name := statement.Name(); name != nil && name.Kind == ast.KindIdentifier {
				names[name.Text()] = true
			}
		}
	}
}

// functionBindings adds to names every name function, a function-like node, binds for its body: its parameters, its
// own name when it is a function expression, and the var declarations of its body.
func functionBindings(function *ast.Node, names map[string]bool) {
	for _, parameter := range function.Parameters() {
		bindingNames(parameter.Name(), names)
	}
	if function.Kind == ast.KindFunctionExpression {
		bindingNames(function.Name(), names)
	}
	if body := function.Body(); body != nil {
		hoistedVars(body, names)
	}
}

// scopeBindings adds to names every name node binds for its children alone, when node opens a scope.
func scopeBindings(node *ast.Node, names map[string]bool) {
	switch {
	case ast.IsFunctionLike(node):
		functionBindings(node, names)
	case isClass(node):
		bindingNames(node.Name(), names)
	case node.Kind == ast.KindBlock || node.Kind == ast.KindModuleBlock:
		lexicalBindings(node.Statements(), names)
	case node.Kind == ast.KindCaseBlock:
		for _, clause := range node.AsCaseBlock().Clauses.Nodes {
			lexicalBindings(clause.Statements(), names)
		}
	case node.Kind == ast.KindCatchClause:
		if declaration := node.AsCatchClause().VariableDeclaration; declaration != nil {
			bindingNames(declaration.Name(), names)
		}
	case node.Kind == ast.KindForStatement:
		declarationListNames(node.AsForStatement().Initializer, true, names)
	case node.Kind == ast.KindForInStatement || node.Kind == ast.KindForOfStatement:
		declarationListNames(node.AsForInOrOfStatement().Initializer, true, names)
	}
}

// parseOutput is text parsed as the TypeScript file name, slash-separated and relative to the repository root.
func parseOutput(name, text string) *ast.SourceFile {
	return parser.ParseSourceFile(ast.SourceFileParseOptions{FileName: "/" + name}, text, core.ScriptKindTS)
}

// soleConst is the name and initializer of statement when it is a const statement declaring one identifier with an
// initializer, and "" and nil for any other statement.
func soleConst(statement *ast.Node) (string, *ast.Node) {
	if statement.Kind != ast.KindVariableStatement {
		return "", nil
	}
	list := statement.AsVariableStatement().DeclarationList
	declarations := list.AsVariableDeclarationList().Declarations.Nodes
	if list.Flags&ast.NodeFlagsBlockScoped != ast.NodeFlagsConst || len(declarations) != 1 {
		return "", nil
	}
	name := declarations[0].Name()
	if name.Kind != ast.KindIdentifier || declarations[0].Initializer() == nil {
		return "", nil
	}
	return name.Text(), declarations[0].Initializer()
}

// internalBindings is the named bindings of statement when it is a value import of internalEntry, and nil otherwise.
func internalBindings(statement *ast.Node) *ast.Node {
	if statement.Kind != ast.KindImportDeclaration {
		return nil
	}
	declaration := statement.AsImportDeclaration()
	if declaration.ImportClause == nil || declaration.ModuleSpecifier.Text() != internalEntry {
		return nil
	}
	clause := declaration.ImportClause.AsImportClause()
	if clause.IsTypeOnly() {
		return nil
	}
	return clause.NamedBindings
}

// isNamespaceImport reports whether bindings, the named bindings of an import, import a namespace.
func isNamespaceImport(bindings *ast.Node) bool {
	return bindings != nil && bindings.Kind == ast.KindNamespaceImport
}

// internalImports is every local name through which file can call internalEntry's shape guard.
func internalImports(file *ast.SourceFile) guardImports {
	imports := guardImports{namespaces: map[string]bool{}, functions: map[string]bool{}}
	for _, statement := range file.Statements.Nodes {
		bindings := internalBindings(statement)
		switch {
		case isNamespaceImport(bindings):
			imports.namespaces[bindings.Name().Text()] = true
		case bindings != nil && bindings.Kind == ast.KindNamedImports:
			for _, specifier := range bindings.AsNamedImports().Elements.Nodes {
				if !specifier.IsTypeOnly() && specifier.PropertyNameOrName().Text() == shapeGuardName {
					imports.functions[specifier.Name().Text()] = true
				}
			}
		}
	}
	return imports
}

// debugCopyOf is the name and initializer of file's DEBUG copy: the const the emitter declares right after the
// namespace import of internalEntry that opens its preamble, named DEBUG or DEBUG_<n>. It is "" and nil when file has
// no such import or no such const follows the first one.
func debugCopyOf(file *ast.SourceFile) (string, *ast.Node) {
	statements := file.Statements.Nodes
	at := slices.IndexFunc(statements, func(statement *ast.Node) bool {
		return isNamespaceImport(internalBindings(statement))
	})
	if at < 0 || at+1 == len(statements) {
		return "", nil
	}
	name, initializer := soleConst(statements[at+1])
	if !debugCopy.MatchString(name) {
		return "", nil
	}
	return name, initializer
}

// identifierName is the text of node, inside any parentheses, when it is an identifier, and "" otherwise.
func identifierName(node *ast.Node) string {
	for node.Kind == ast.KindParenthesizedExpression {
		node = node.AsParenthesizedExpression().Expression
	}
	if node.Kind != ast.KindIdentifier {
		return ""
	}
	return node.Text()
}

// calls reports whether node calls the shape guard through one of c: a member of a namespace import of
// internalEntry, or a name the guard is imported under. A test that calls the runtime's assertShape imports it from
// src/shape-guard.ts, so its calls are not shape guards.
func (c guardImports) calls(node *ast.Node) bool {
	if node.Kind != ast.KindCallExpression {
		return false
	}
	callee := node.AsCallExpression().Expression
	if callee.Kind != ast.KindPropertyAccessExpression {
		return c.functions[identifierName(callee)]
	}
	access := callee.AsPropertyAccessExpression()
	return access.Name().Text() == shapeGuardName && c.namespaces[identifierName(access.Expression)]
}

// andOperands is the left and right operand of node when node is an && expression.
func andOperands(node *ast.Node) (left, right *ast.Node, ok bool) {
	if node.Kind != ast.KindBinaryExpression {
		return nil, nil, false
	}
	binary := node.AsBinaryExpression()
	return binary.Left, binary.Right, binary.OperatorToken.Kind == ast.KindAmpersandAmpersandToken
}

// collectGuards appends to w.guards every shape guard in node, given sc, the scope node runs in, and gates, the gates
// that must be true for node to run. Each gate records whether a local binding declares its name where the &&
// expression reads it.
func collectGuards(node *ast.Node, w *guardWalk, sc *scope, gates []gate) {
	if left, right, ok := andOperands(node); ok {
		collectGuards(left, w, sc, gates)
		rightGates := gates
		if name := identifierName(left); name != "" {
			rightGates = append(slices.Clone(gates), gate{name: name, local: sc.binds(name)})
		}
		collectGuards(right, w, sc, rightGates)
		return
	}
	if w.imports.calls(node) {
		w.guards = append(w.guards, guard{gates: gates, pos: node.Pos()})
	}
	inner := sc.enter(node)
	node.ForEachChild(func(child *ast.Node) bool {
		collectGuards(child, w, inner, gates)
		return false
	})
}

// guardProblem is how g can run while the file's DEBUG copy, named copyName, is false, and "" when a gate of g reads
// that copy. copyName is "" when the file has no copy.
func guardProblem(g guard, copyName string) string {
	readsCopy := slices.ContainsFunc(g.gates, func(candidate gate) bool {
		return copyName != "" && candidate.name == copyName && !candidate.local
	})
	switch {
	case readsCopy:
		return ""
	case len(g.gates) == 0:
		return "the shape guard runs without a DEBUG gate"
	default:
		names := make([]string, 0, len(g.gates))
		for _, candidate := range g.gates {
			names = append(names, candidate.String())
		}
		return "the shape guard is gated by " + strings.Join(names, ", ") + ", not by the file's DEBUG copy"
	}
}

// children is every child of node, in order.
func children(node *ast.Node) []*ast.Node {
	var all []*ast.Node
	node.ForEachChild(func(child *ast.Node) bool {
		all = append(all, child)
		return false
	})
	return all
}

// leafText is the text of an identifier or literal node, and "" for any other node.
func leafText(node *ast.Node) string {
	switch node.Kind {
	case ast.KindIdentifier, ast.KindStringLiteral, ast.KindNumericLiteral, ast.KindBigIntLiteral,
		ast.KindNoSubstitutionTemplateLiteral, ast.KindTemplateHead, ast.KindTemplateMiddle, ast.KindTemplateTail:
		return node.Text()
	default:
		return ""
	}
}

// unaryOperator is the operator of a prefix or postfix unary expression, which is no child node, and KindUnknown for
// any other node.
func unaryOperator(node *ast.Node) ast.Kind {
	switch node.Kind {
	case ast.KindPrefixUnaryExpression:
		return node.AsPrefixUnaryExpression().Operator
	case ast.KindPostfixUnaryExpression:
		return node.AsPostfixUnaryExpression().Operator
	default:
		return ast.KindUnknown
	}
}

// sameTree reports whether a and b are the same expression: the same kinds, texts, and operators, child by child.
func sameTree(a, b *ast.Node) bool {
	if a.Kind != b.Kind || leafText(a) != leafText(b) || unaryOperator(a) != unaryOperator(b) {
		return false
	}
	aChildren, bChildren := children(a), children(b)
	return slices.EqualFunc(aChildren, bChildren, sameTree)
}

// fileProblems is the number of shape guards in text, the output of the file name, and every problem with it: each
// way a guard can run while the file's DEBUG copy is false, and a copy initialized otherwise than runtime, the
// initializer of DEBUG in src/debug.ts, whether or not the copy gates a guard.
func fileProblems(name, text string, runtime *ast.Node) (int, []string) {
	file := parseOutput(name, text)
	walk := guardWalk{imports: internalImports(file)}
	collectGuards(file.AsNode(), &walk, nil, nil)
	copyName, initializer := debugCopyOf(file)
	var problems []string
	for _, g := range walk.guards {
		if problem := guardProblem(g, copyName); problem != "" {
			problems = append(problems, fmt.Sprintf("%s:%d: %s", name, lineOf(text, scanner.SkipTrivia(text, g.pos)), problem))
		}
	}
	if initializer != nil && !sameTree(initializer, runtime) {
		problems = append(problems, fmt.Sprintf("%s: the DEBUG copy %s is initialized to %s, not as src/debug.ts "+
			"initializes DEBUG", name, copyName, text[scanner.SkipTrivia(text, initializer.Pos()):initializer.End()]))
	}
	return len(walk.guards), problems
}

// unstrippedProblems is every problem fileProblems finds in outputs, keyed by file name relative to the repository
// root, in file name order and leaving out every file under src/; then noGuards when no file left in holds a shape
// guard.
func unstrippedProblems(outputs map[string]string, runtime *ast.Node) []string {
	var problems []string
	guards := 0
	for _, name := range slices.Sorted(maps.Keys(outputs)) {
		if strings.HasPrefix(name, "src/") {
			continue
		}
		found, fileFound := fileProblems(name, outputs[name], runtime)
		guards += found
		problems = append(problems, fileFound...)
	}
	if guards == 0 {
		problems = append(problems, noGuards)
	}
	return problems
}

// runtimeDebug is the initializer of the top-level const DEBUG in text, the source of a src/debug.ts.
func runtimeDebug(t *testing.T, text string) *ast.Node {
	t.Helper()
	for _, statement := range parseOutput(debugFile, text).Statements.Nodes {
		if name, initializer := soleConst(statement); name == "DEBUG" {
			return initializer
		}
	}
	t.Fatalf("src/debug.ts declares no top-level const DEBUG with an initializer:\n%s", text)
	return nil
}

// jsonValue is the value node, an expression of a parsed JSON file, denotes. It errors on an expression that is no
// JSON value.
func jsonValue(node *ast.Node) (any, error) {
	switch node.Kind {
	case ast.KindObjectLiteralExpression:
		object := map[string]any{}
		for _, property := range node.AsObjectLiteralExpression().Properties.Nodes {
			if property.Kind != ast.KindPropertyAssignment {
				return nil, fmt.Errorf("JSON object member of kind %v", property.Kind)
			}
			value, err := jsonValue(property.Initializer())
			if err != nil {
				return nil, err
			}
			object[property.Name().Text()] = value
		}
		return object, nil
	case ast.KindArrayLiteralExpression:
		array := []any{}
		for _, element := range node.Elements() {
			value, err := jsonValue(element)
			if err != nil {
				return nil, err
			}
			array = append(array, value)
		}
		return array, nil
	case ast.KindStringLiteral:
		return node.Text(), nil
	case ast.KindNumericLiteral:
		return strconv.ParseFloat(node.Text(), 64)
	case ast.KindTrueKeyword, ast.KindFalseKeyword:
		return node.Kind == ast.KindTrueKeyword, nil
	case ast.KindNullKeyword:
		return nil, nil
	default:
		return nil, fmt.Errorf("JSON value of kind %v", node.Kind)
	}
}

// tsconfigPlugins is the --plugins-json ttsc passes the sidecar for text, the tsconfig name: each entry of its
// compilerOptions.plugins as the tsconfig wrote it, under config, beside the descriptor's name and the transform
// stage. Comments and trailing commas are read as the compiler reads them in a tsconfig.
func tsconfigPlugins(t *testing.T, name, text string) string {
	t.Helper()
	file := parser.ParseSourceFile(ast.SourceFileParseOptions{FileName: "/" + name}, text, core.ScriptKindJSON)
	if len(file.Diagnostics()) > 0 || len(file.Statements.Nodes) != 1 {
		t.Fatalf("%s does not parse as one JSON value:\n%s", name, text)
	}
	root, err := jsonValue(file.Statements.Nodes[0].AsExpressionStatement().Expression)
	if err != nil {
		t.Fatalf("read %s: %v", name, err)
	}
	config, _ := root.(map[string]any)
	options, _ := config["compilerOptions"].(map[string]any)
	plugins, ok := options["plugins"].([]any)
	if !ok || len(plugins) == 0 {
		t.Fatalf("%s lists no compilerOptions.plugins entry:\n%s", name, text)
	}
	entries := make([]map[string]any, 0, len(plugins))
	for _, entry := range plugins {
		entries = append(entries, map[string]any{"config": entry, "name": descriptorName, "stage": "transform"})
	}
	encoded, err := json.Marshal(entries)
	if err != nil {
		t.Fatalf("json.Marshal(%v) error = %v, want nil", entries, err)
	}
	return string(encoded)
}

// testModuleOutputs is the transform output of every test module, keyed by file name relative to repo, the
// repository root; envelope keys are relative to tests, the tests directory.
func testModuleOutputs(t *testing.T, repo, tests string, typescript map[string]string) map[string]string {
	t.Helper()
	outputs := map[string]string{}
	for key, text := range typescript {
		rel, err := filepath.Rel(filepath.FromSlash(repo), filepath.FromSlash(path.Join(tests, key)))
		if err != nil {
			t.Fatalf("filepath.Rel(%q, %q) error = %v, want nil", repo, key, err)
		}
		outputs[filepath.ToSlash(rel)] = text
	}
	return outputs
}

func TestRun_WhenTransformingTheTestModules_GatesEveryShapeGuardBehindTheRuntimeDEBUG(t *testing.T) {
	t.Parallel()
	tests := resolvedDir(t, testsRoot)
	repo := path.Dir(tests)
	runtime := runtimeDebug(t, fileText(t, filepath.Join(filepath.FromSlash(repo), filepath.FromSlash(debugFile))))
	tsconfig := filepath.Join(filepath.FromSlash(tests), optimizerTsconfig)
	plugins := tsconfigPlugins(t, optimizerTsconfig, fileText(t, tsconfig))
	argv := []string{"transform", "--tsconfig=" + optimizerTsconfig, "--plugins-json=" + plugins, "--cwd=" + tests}

	got := runSidecar(argv)

	requireStatus(t, "transform", got, statusOK)
	outputs := testModuleOutputs(t, repo, tests, decodeEnvelope(t, got.stdout).TypeScript)
	for _, problem := range unstrippedProblems(outputs, runtime) {
		t.Error(problem)
	}
}

func TestTsconfigPlugins_WhenTheTsconfigHasCommentsAndTrailingCommas_ReadsEachEntry(t *testing.T) {
	t.Parallel()
	const tsconfig = `{
	// The optimized unit's project.
	"extends": "./tsconfig.json",
	"compilerOptions": {
		/* the optimizer */
		"plugins": [{ "transform": "../src/plugin/optimizer.ts", "strict": false, }],
	},
}
`
	const want = `[{"config":{"strict":false,"transform":"../src/plugin/optimizer.ts"},"name":"ecstatic",` +
		`"stage":"transform"}]`

	got := tsconfigPlugins(t, optimizerTsconfig, tsconfig)

	if got != want {
		t.Errorf("tsconfigPlugins() = %s, want %s", got, want)
	}
}

// checkerRuntime is the src/debug.ts the checker's rejecting unit cases compare DEBUG copies with.
const checkerRuntime = `declare const NDEBUG: boolean | undefined;
export const DEBUG = typeof NDEBUG === "undefined" || !NDEBUG;
`

// runtimeCopy is a DEBUG copy initialized as checkerRuntime initializes DEBUG.
const runtimeCopy = `const DEBUG = typeof NDEBUG === "undefined" || !NDEBUG;`

// gatedGuard is a shape guard gated by runtimeCopy.
const gatedGuard = "DEBUG && ecstatic_internal.assertShape(storage, shapeKey);"

// bareGuard is the shape guard with no gate.
const bareGuard = "ecstatic_internal.assertShape(storage, shapeKey);"

// guardedModule is the output of a rewritten module whose preamble declares declarations, on its second line, and
// whose function holds guard, on its fifth.
func guardedModule(declarations, guard string) string {
	return printed.NamespaceImport + "\n" +
		declarations + "\n" +
		`const shapeKey = "c8:Position{1:x=n,1:y=n}|";` + "\n" +
		"export function run(storage: unknown): void {\n" +
		"  " + guard + "\n" +
		"}\n"
}

// flagsFile is a module that binds DEBUG itself, so the emitter names its DEBUG copy apart.
const flagsFile = "app/flags.ts"

// emittedOutputs is the transform output, keyed like the envelope, of a runtime project whose mainFile and flagsFile
// both compile each call to inlined loops, flagsFile beside a top-level DEBUG of its own; and the initializer of
// DEBUG in the project's src/debug.ts.
func emittedOutputs(t *testing.T) (map[string]string, *ast.Node) {
	t.Helper()
	files := runtimeProject(t, inlinedSource)
	files[flagsFile] = inlinedSource + "export const DEBUG = false;\n"
	got := runTransform(project.Write(t, files), lenientPlugins)
	requireStatus(t, "transform", got, statusOK)
	return decodeEnvelope(t, got.stdout).TypeScript, runtimeDebug(t, files[debugFile])
}

func TestUnstrippedProblems_WhenEveryGuardIsGatedByACopyOfTheRuntimeDEBUG_ReportsNothing(t *testing.T) {
	t.Parallel()
	emitted, runtime := emittedOutputs(t)
	tests := []struct {
		outputs map[string]string
		name    string
	}{
		{
			name:    "guards the emitter writes",
			outputs: map[string]string{mainFile: emitted[mainFile]},
		},
		{
			name:    "guards the emitter writes beside the module's own DEBUG",
			outputs: map[string]string{flagsFile: emitted[flagsFile]},
		},
		{
			name: "guard with no gate under src/ beside the guards the emitter writes",
			outputs: map[string]string{
				mainFile:      emitted[mainFile],
				"src/each.ts": guardedModule(runtimeCopy, bareGuard),
			},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()

			got := unstrippedProblems(tt.outputs, runtime)

			if len(got) != 0 {
				t.Errorf("unstrippedProblems() = %q, want none", got)
			}
		})
	}
}

// rejectedModule is the test module the checker's rejecting unit cases write their outputs as.
const rejectedModule = "tests/unit/a.test.ts"

// assertProblems fails t unless unstrippedProblems of outputs, against checkerRuntime, is want.
func assertProblems(t *testing.T, outputs map[string]string, want []string) {
	t.Helper()
	runtime := runtimeDebug(t, checkerRuntime)

	got := unstrippedProblems(outputs, runtime)

	if diff := cmp.Diff(want, got); diff != "" {
		t.Errorf("unstrippedProblems() mismatch (-want +got):\n%s", diff)
	}
}

func TestUnstrippedProblems_WhenALocalBindingShadowsTheDEBUGCopy_NamesTheGuard(t *testing.T) {
	t.Parallel()
	tests := []struct {
		binding string
		guard   string
	}{
		{binding: "function parameter", guard: "function f(DEBUG: boolean) { " + gatedGuard + " }"},
		{binding: "destructured parameter", guard: "function f({ DEBUG }: { DEBUG: boolean }) { " + gatedGuard + " }"},
		{binding: "block-scoped const", guard: "{ const DEBUG = true; " + gatedGuard + " }"},
		{binding: "hoisted var", guard: "function f() { " + gatedGuard + " var DEBUG = true; }"},
		{binding: "catch clause", guard: "try { throw true; } catch (DEBUG) { " + gatedGuard + " }"},
		{binding: "class name", guard: "void class DEBUG { static { " + gatedGuard + " } };"},
		{binding: "function expression name", guard: "void function DEBUG() { " + gatedGuard + " };"},
		{binding: "for-of const", guard: "for (const DEBUG of [true]) " + gatedGuard},
	}
	for _, tt := range tests {
		t.Run(tt.binding, func(t *testing.T) {
			t.Parallel()
			assertProblems(t, map[string]string{rejectedModule: guardedModule(runtimeCopy, tt.guard)},
				[]string{rejectedModule + ":5: the shape guard is gated by DEBUG (a local binding), not by the file's DEBUG copy"})
		})
	}
}

// problemCase is a set of outputs the checker rejects and the problems it names in them.
type problemCase struct {
	outputs map[string]string
	name    string
	want    []string
}

// runProblemCases runs each of cases in parallel under t.
func runProblemCases(t *testing.T, cases []problemCase) {
	t.Helper()
	for _, tt := range cases {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			assertProblems(t, tt.outputs, tt.want)
		})
	}
}

func TestUnstrippedProblems_WhenAGuardCanRunWithoutTheRuntimeDEBUG_NamesTheGuard(t *testing.T) {
	t.Parallel()
	runProblemCases(t, []problemCase{
		{
			name:    "guard with no gate",
			outputs: map[string]string{rejectedModule: guardedModule(runtimeCopy, bareGuard)},
			want:    []string{rejectedModule + ":5: the shape guard runs without a DEBUG gate"},
		},
		{
			name: "guard gated by another identifier",
			outputs: map[string]string{rejectedModule: guardedModule(runtimeCopy+" const enabled = true;",
				"enabled && ecstatic_internal.assertShape(storage, shapeKey);")},
			want: []string{rejectedModule + ":5: the shape guard is gated by enabled, not by the file's DEBUG copy"},
		},
		{
			name: "guard through a named import with no gate",
			outputs: map[string]string{rejectedModule: `import { assertShape } from "ecstatic/internal";` + "\n" +
				"assertShape(storage, shapeKey);\n"},
			want: []string{rejectedModule + ":2: the shape guard runs without a DEBUG gate"},
		},
		{
			name: "guard through an aliased named import with no gate",
			outputs: map[string]string{rejectedModule: `import { assertShape as check } from "ecstatic/internal";` + "\n" +
				"check(storage, shapeKey);\n"},
			want: []string{rejectedModule + ":2: the shape guard runs without a DEBUG gate"},
		},
	})
}

func TestUnstrippedProblems_WhenTheDEBUGCopyIsInitializedOtherwise_NamesTheCopy(t *testing.T) {
	t.Parallel()
	wrongCopy := rejectedModule + ": the DEBUG copy DEBUG is initialized to true, not as src/debug.ts initializes DEBUG"
	runProblemCases(t, []problemCase{
		{
			name:    "copy that gates a guard",
			outputs: map[string]string{rejectedModule: guardedModule("const DEBUG = true;", gatedGuard)},
			want:    []string{wrongCopy},
		},
		{
			name: "copy that gates no guard",
			outputs: map[string]string{
				rejectedModule:         guardedModule("const DEBUG = true;", "void storage;"),
				"tests/unit/b.test.ts": guardedModule(runtimeCopy, gatedGuard),
			},
			want: []string{wrongCopy},
		},
		{
			name: "copy with another unary operator",
			outputs: map[string]string{rejectedModule: guardedModule(
				`const DEBUG = typeof NDEBUG === "undefined" || -NDEBUG;`, gatedGuard)},
			want: []string{rejectedModule + `: the DEBUG copy DEBUG is initialized to typeof NDEBUG === "undefined" || ` +
				"-NDEBUG, not as src/debug.ts initializes DEBUG"},
		},
	})
}

func TestUnstrippedProblems_WhenNoTestModuleHoldsAShapeGuard_ReportsNothingToCheck(t *testing.T) {
	t.Parallel()
	runProblemCases(t, []problemCase{
		{
			name:    "no guard in any output",
			outputs: map[string]string{rejectedModule: guardedModule(runtimeCopy, "void storage;")},
			want:    []string{noGuards},
		},
		{
			name: "only a direct call of the runtime's assertShape",
			outputs: map[string]string{rejectedModule: `import { assertShape } from "../../src/shape-guard.js";` + "\n" +
				`assertShape(storage, "c8:Position{1:x=n,1:y=n}|");` + "\n"},
			want: []string{noGuards},
		},
		{
			name:    "guards only under src/",
			outputs: map[string]string{"src/each.ts": guardedModule(runtimeCopy, gatedGuard)},
			want:    []string{noGuards},
		},
	})
}
