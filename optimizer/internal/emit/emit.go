// Package emit builds the output of a rewritten file: the inlined loop that replaces each rewritten each call,
// and the preamble those loops share, either as a rewritten AST or as the source text with them spliced in. It
// builds through the tsgo factory from the AST, the node table, and the plan, and never depends on the checker or
// on ttsc.
package emit

import (
	"fmt"
	"maps"
	"regexp"
	"slices"

	"github.com/microsoft/typescript-go/shim/ast"
	"github.com/microsoft/typescript-go/shim/printer"

	"github.com/jeffzi/ecstatic/optimizer/internal/facts"
	"github.com/jeffzi/ecstatic/optimizer/internal/nodes"
	"github.com/jeffzi/ecstatic/optimizer/internal/plan"
	"github.com/jeffzi/ecstatic/optimizer/internal/syntax"
)

// internalModule is the entry point generated code reaches the runtime through.
const internalModule = "ecstatic/internal"

// identifierName matches the names a property access can spell; any other name is read with an element access.
var identifierName = regexp.MustCompile(`^[A-Za-z_$][A-Za-z0-9_$]*$`)

// File is one source file whose each calls are being inlined.
type File struct {
	ctx    *printer.EmitContext
	source *ast.SourceFile
	table  *nodes.Table
	debug  *Debug
	// replaced maps each rewritten call's statement, or the arrow body the call is, to its loop.
	replaced map[*ast.Node]*ast.Node
	// preamble is nil until the first loop is inlined.
	preamble *preamble
	applied  ruleSet
	// beforeCommit, when set, is called with each inlining once its loop is built, before Inline records the loop; a
	// test sets it to make Inline panic at the last point the file must still be as it was.
	beforeCommit func(plan.EachInlining)
}

// preamble is what a file with at least one rewrite declares once, ahead of its own statements.
type preamble struct {
	namespace *ast.Node
	debug     *ast.Node
	keys      []shapeKey
}

type shapeKey struct {
	name *ast.Node
	key  string
}

// NewFile starts the rewrite of source, whose node IDs table maps, through ctx, the emit context the rewritten file
// must be printed with. Every rewritten file copies debug's initializer.
func NewFile(ctx *printer.EmitContext, source *ast.SourceFile, table *nodes.Table, debug *Debug) *File {
	return &File{ctx: ctx, source: source, table: table, debug: debug, replaced: map[*ast.Node]*ast.Node{}, applied: ruleSet{}}
}

// tableNode returns the node of id, panicking naming what it is when table does not hold it.
func tableNode(table *nodes.Table, id facts.NodeID, what string) *ast.Node {
	node, ok := table.Node(id)
	if !ok {
		panic(fmt.Sprintf("emit: %s %d is not in the node table", what, id))
	}
	return node
}

// Applied returns the rules of the rewrite catalog that the loops Inline built so far apply, in catalog order. A site
// whose Inline panicked adds none.
func (f *File) Applied() []Rule {
	return f.applied.sorted()
}

// Inline replaces the call of inlining with the loop of eachStorageMatched (src/entity/each.ts), lowering
// uses, the view uses of its callback.
//
// A panic, such as a view use with no lowering, leaves the file as it was before the call, so the caller can recover
// it and keep that site's runtime call.
func (f *File) Inline(inlining plan.EachInlining, uses []facts.ViewUse) {
	call := tableNode(f.table, inlining.Call, "call")
	pre := f.nextPreamble()
	key := pre.keyName(f.ctx, inlining.Shape.Key())
	l := &loop{
		ctx:      f.ctx,
		table:    f.table,
		mode:     inlining.Mode,
		shape:    inlining.Shape,
		guard:    guardNames{debug: pre.debug, namespace: pre.namespace, key: key},
		records:  map[string]*record{},
		columns:  map[column]*ast.Node{},
		lowering: map[*ast.Node]facts.ViewUse{},
		applied:  ruleSet{},
	}
	l.transplant = newTransplant(f.ctx, f.table, inlining, l.applied)
	block := l.build(call, uses)
	if f.beforeCommit != nil {
		f.beforeCommit(inlining)
	}

	target := call
	if call.Parent.Kind == ast.KindExpressionStatement {
		target = call.Parent
	}
	f.replaced[target] = block
	f.preamble = pre
	maps.Copy(f.applied, l.applied)
}

// nextPreamble returns a copy of the file's preamble that Inline may extend, allocating the file-level names on
// the first rewrite.
func (f *File) nextPreamble() *preamble {
	if f.preamble != nil {
		next := new(*f.preamble)
		next.keys = slices.Clone(next.keys)
		return next
	}
	fileLevel := printer.AutoGenerateOptions{Flags: printer.GeneratedIdentifierFlagsOptimistic | printer.GeneratedIdentifierFlagsFileLevel}
	return &preamble{
		namespace: f.ctx.Factory.NewUniqueNameEx("ecstatic_internal", fileLevel),
		debug:     f.ctx.Factory.NewUniqueNameEx("DEBUG", fileLevel),
	}
}

// keyName returns the name of the constant holding key, adding the constant when p has none for it.
func (p *preamble) keyName(ctx *printer.EmitContext, key string) *ast.Node {
	for _, k := range p.keys {
		if k.key == key {
			return k.name
		}
	}
	name := ctx.Factory.NewUniqueNameEx("shapeKey", optimistic())
	p.keys = append(p.keys, shapeKey{name: name, key: key})
	return name
}

// SourceFile returns the rewritten file: every inlined call replaced by its loop, and the preamble after the
// directive prologue. A file with no inlined call is returned unchanged. It holds the rewrite Print splices, for an
// emitter that prints the whole file.
func (f *File) SourceFile() *ast.SourceFile {
	if f.preamble == nil {
		return f.source
	}
	var visitor *ast.NodeVisitor
	visitor = f.ctx.NewNodeVisitor(func(node *ast.Node) *ast.Node {
		if built, ok := f.replaced[node]; ok {
			return built
		}
		return visitor.VisitEachChild(node)
	})
	visited := visitor.VisitEachChild(f.source.AsNode()).AsSourceFile()
	factory := f.ctx.Factory
	prologue, rest := factory.SplitStandardPrologue(visited.Statements.Nodes)
	statements := slices.Concat(prologue, f.preambleStatements(), rest)
	return factory.UpdateSourceFile(visited, factory.NewNodeList(statements), visited.EndOfFileToken).AsSourceFile()
}

// preambleStatements are the namespace import of ecstatic/internal, the file's copy of the DEBUG gate, and one
// constant per shape key.
func (f *File) preambleStatements() []*ast.Node {
	factory := f.ctx.Factory
	clause := factory.NewImportClause(ast.KindUnknown, nil, factory.NewNamespaceImport(f.preamble.namespace))
	statements := []*ast.Node{
		factory.NewImportDeclaration(nil, clause, factory.NewStringLiteral(internalModule, ast.TokenFlagsNone), nil),
		constStatement(f.ctx, declaration(f.ctx, f.preamble.debug, factory.DeepCloneNode(f.debug.initializer))),
	}
	for _, k := range f.preamble.keys {
		literal := factory.NewStringLiteral(k.key, ast.TokenFlagsNone)
		statements = append(statements, constStatement(f.ctx, declaration(f.ctx, k.name, literal)))
	}
	return statements
}

// guardNames are the preamble names one loop's shape guard refers to.
type guardNames struct {
	debug     *ast.Node
	namespace *ast.Node
	key       *ast.Node
}

type column struct {
	comp  string
	field string
}

// record is the local holding one component's SoA record, the storage's per-component alias.
type record struct {
	name *ast.Node
	comp string
}

// loop builds the block that replaces one each call.
type loop struct {
	ctx   *printer.EmitContext
	table *nodes.Table
	// storage, n, and i are the storage temp, the row count, and the row index.
	storage, n, i *ast.Node
	// entities is the hoisted entity array; nil in realloc-safe mode or when the body reads no id.
	entities *ast.Node
	// mask is the hoisted presence mask; nil in realloc-safe mode or when the body tests no optional.
	mask    *ast.Node
	records map[string]*record
	// columns maps each column the body touches to its hoisted local; empty in realloc-safe mode.
	columns map[column]*ast.Node
	// lowering maps each view-use node of the body to its use.
	lowering   map[*ast.Node]facts.ViewUse
	applied    ruleSet
	guard      guardNames
	transplant *transplant
	// temps are the locals the lowerings hold a value in, declared once per call.
	temps []*ast.Node
	shape facts.ArchShape
	// recordOrder and columnOrder list the hoists in the order the body first touches them.
	recordOrder []*record
	columnOrder []column
	mode        plan.Mode
}

// build returns the block replacing call, with uses its callback's view uses. It mirrors eachStorageMatched
// (src/entity/each.ts) for a storage with no active matcher: the storage is evaluated once, the row count is
// read once, and rows run from the last to the first.
func (l *loop) build(call *ast.Node, uses []facts.ViewUse) *ast.Node {
	factory := l.ctx.Factory
	l.storage = factory.NewUniqueNameEx("storage", optimistic())
	l.n = factory.NewUniqueNameEx("n", optimistic())
	l.i = factory.NewUniqueNameEx("i", optimistic())
	if l.mode == plan.ModeHoisted {
		l.applied.add(ruleModeHoisted)
	} else {
		l.applied.add(ruleModeReallocSafe)
	}
	for _, use := range uses {
		l.collect(use)
	}
	args := call.Arguments()
	body := l.rowBody(args[len(args)-1])

	inner := l.hoists()
	inner = append(inner, l.rowLoop(body))
	l.noteOuterReferences(call, args[len(args)-1])
	return factory.NewBlock(factory.NewNodeList([]*ast.Node{
		constStatement(l.ctx, declaration(l.ctx, l.storage, args[0])),
		l.shapeGuard(),
		constStatement(l.ctx, declaration(l.ctx, l.n, l.storageArray("n"))),
		factory.NewIfStatement(
			binary(l.ctx, l.n, ast.KindGreaterThanToken, number(l.ctx, "0")),
			factory.NewBlock(factory.NewNodeList(inner), true),
			nil,
		),
	}), true)
}

// noteOuterReferences records the rules of the references in callback, the callback of call, to bindings outside it:
// one whose name a binding the loop adds also has, which the printer then gives a fresh name, and a read
// of an outer let, const, or class still in its dead zone, which still throws where the callback would.
func (l *loop) noteOuterReferences(call, callback *ast.Node) {
	added := l.addedNames()
	for _, ref := range outerReferences(callback) {
		if slices.Contains(added, ref.Text()) {
			l.applied.add(ruleOuterBinding)
		}
		if inOwnCode(ref, callback, ruleOuterLetDeadZone) && inDeadZone(ref.Text(), call) {
			l.applied.add(ruleOuterLetDeadZone)
		}
	}
}

// addedNames are the base names of the bindings the loop declares in the block replacing the call.
func (l *loop) addedNames() []string {
	added := []*ast.Node{l.storage, l.n, l.i, l.entities, l.mask}
	for _, r := range l.recordOrder {
		added = append(added, r.name)
	}
	for _, col := range l.columnOrder {
		added = append(added, l.columns[col])
	}
	added = append(added, l.temps...)
	names := make([]string, 0, len(added))
	for _, name := range added {
		if name != nil {
			names = append(names, name.Text())
		}
	}
	return names
}

// outerReferences lists, in source order, the identifiers of callback that refer to a binding by a name that no
// parameter or declaration of callback binds, so the binding is outside it.
func outerReferences(callback *ast.Node) []*ast.Node {
	declared := map[string]bool{}
	var references []*ast.Node
	var walk func(node *ast.Node)
	walk = func(node *ast.Node) {
		if node.Kind == ast.KindIdentifier {
			if ast.IsDeclarationNameOrImportPropertyName(node) {
				declared[node.Text()] = true
			} else if isReference(node) {
				references = append(references, node)
			}
		}
		node.ForEachChild(func(child *ast.Node) bool {
			walk(child)
			return false
		})
	}
	walk(callback)
	return slices.DeleteFunc(references, func(ref *ast.Node) bool { return declared[ref.Text()] })
}

// isReference reports whether id, an identifier that names no declaration, refers to a binding: it is not a type, a
// property name, a label, or the name of a meta-property.
func isReference(id *ast.Node) bool {
	if ast.IsPartOfTypeNode(id) {
		return false
	}
	parent := id.Parent
	if isLabelStatement(parent) {
		return parent.Label() != id
	}
	switch parent.Kind {
	case ast.KindPropertyAccessExpression, ast.KindQualifiedName, ast.KindMetaProperty:
		return parent.Name() != id
	}
	return true
}

// inDeadZone reports whether a read of name in the callback of call reads a let, const, or class that a statement
// list enclosing call, up to the function holding it, declares after the call starts, so the read throws: the nearest
// declaration of name decides, and a var or function declaration is never in its dead zone.
func inDeadZone(name string, call *ast.Node) bool {
	for node := call.Parent; node != nil && !isLabelScope(node); node = node.Parent {
		if !hasStatements(node) {
			continue
		}
		for _, statement := range node.Statements() {
			if blockScoped, declares := declaresName(statement, name); declares {
				return blockScoped && statement.End() > call.Pos()
			}
		}
	}
	return false
}

// hasStatements reports whether node holds a statement list whose let, const, and class declarations are scoped to
// it: a block, a source file, or a module block.
func hasStatements(node *ast.Node) bool {
	return node.Kind == ast.KindBlock || node.Kind == ast.KindSourceFile || node.Kind == ast.KindModuleBlock
}

// declaresName reports whether statement declares name, and whether as a let, const, or class, which has a dead zone.
func declaresName(statement *ast.Node, name string) (blockScoped, declares bool) {
	switch statement.Kind {
	case ast.KindVariableStatement:
		list := statement.AsVariableStatement().DeclarationList
		for _, decl := range list.AsVariableDeclarationList().Declarations.Nodes {
			syntax.ForEachBoundName(decl.Name(), func(bound string) {
				declares = declares || bound == name
			})
		}
		return list.Flags&ast.NodeFlagsBlockScoped != 0, declares
	case ast.KindClassDeclaration, ast.KindFunctionDeclaration:
		declared := statement.Name() != nil && statement.Name().Text() == name
		return statement.Kind == ast.KindClassDeclaration, declared
	}
	return false, false
}

// collect records the node of use and the record, column, mask, or entity array it reads.
func (l *loop) collect(use facts.ViewUse) {
	node := tableNode(l.table, use.Node, "view use")
	l.lowering[node] = use
	factory := l.ctx.Factory
	if use.Kind == facts.UseID {
		if l.entities == nil && l.mode == plan.ModeHoisted {
			l.entities = factory.NewUniqueNameEx("entities", optimistic())
		}
		return
	}
	if _, optional := l.slot(use.Comp); optional && !use.Alias && l.mask == nil && l.mode == plan.ModeHoisted {
		l.mask = factory.NewUniqueNameEx("mask", optimistic())
	}
	if use.Field != "" {
		l.collectColumn(use)
	}
}

// collectColumn records the record and, in hoisted mode, the column of use's field.
func (l *loop) collectColumn(use facts.ViewUse) {
	factory := l.ctx.Factory
	if _, seen := l.records[use.Comp]; !seen {
		base := "record"
		if identifierName.MatchString(use.Comp) {
			base = use.Comp + "Record"
		}
		r := &record{name: factory.NewUniqueNameEx(base, optimistic()), comp: use.Comp}
		l.records[use.Comp] = r
		l.recordOrder = append(l.recordOrder, r)
	}
	col := column{comp: use.Comp, field: use.Field}
	if _, seen := l.columns[col]; !seen && l.mode == plan.ModeHoisted {
		l.columns[col] = factory.NewUniqueNameEx(use.Field+"Column", optimistic())
		l.columnOrder = append(l.columnOrder, col)
	}
}

// shapeGuard is `DEBUG && ecstatic_internal.assertShape(storage, KEY)`, which runs assertShape
// (src/shape-guard.ts) once per call, before any row.
func (l *loop) shapeGuard() *ast.Node {
	factory := l.ctx.Factory
	assertShape := factory.NewPropertyAccessExpression(l.guard.namespace, nil, factory.NewIdentifier("assertShape"), ast.NodeFlagsNone)
	guarded := factory.NewCallExpression(assertShape, nil, nil, factory.NewNodeList([]*ast.Node{l.storage, l.guard.key}), ast.NodeFlagsNone)
	return factory.NewExpressionStatement(binary(l.ctx, l.guard.debug, ast.KindAmpersandAmpersandToken, guarded))
}

// hoists declares, once per call, the SoA record of every component the body touches, read through the storage's
// per-component alias that createStorage (src/world.ts) writes, in hoisted mode every touched column, the
// entity array, and the presence mask, and the temps the lowerings hold values in.
func (l *loop) hoists() []*ast.Node {
	var statements []*ast.Node
	if len(l.recordOrder) > 0 {
		records := make([]*ast.Node, 0, len(l.recordOrder))
		for _, r := range l.recordOrder {
			records = append(records, declaration(l.ctx, r.name, member(l.ctx, l.storage, r.comp)))
		}
		statements = append(statements, constStatement(l.ctx, records...))
	}
	var locals []*ast.Node
	for _, col := range l.columnOrder {
		locals = append(locals, declaration(l.ctx, l.columns[col], l.recordColumn(col)))
	}
	if l.entities != nil {
		locals = append(locals, declaration(l.ctx, l.entities, l.storageArray("entities")))
	}
	if l.mask != nil {
		locals = append(locals, declaration(l.ctx, l.mask, l.storageArray("mask")))
	}
	if len(locals) > 0 {
		statements = append(statements, constStatement(l.ctx, locals...))
	}
	if len(l.temps) > 0 {
		temps := make([]*ast.Node, 0, len(l.temps))
		for _, t := range l.temps {
			temps = append(temps, declaration(l.ctx, t, nil))
		}
		statements = append(statements, letStatement(l.ctx, temps...))
	}
	return statements
}

// rowLoop is `for (let i = n - 1; i >= 0; i--) body`, the row loop of eachStorageMatched (src/entity/each.ts).
func (l *loop) rowLoop(body []*ast.Node) *ast.Node {
	factory := l.ctx.Factory
	start := declaration(l.ctx, l.i, binary(l.ctx, l.n, ast.KindMinusToken, number(l.ctx, "1")))
	return l.transplant.labeled(factory.NewForStatement(
		factory.NewVariableDeclarationList(factory.NewNodeList([]*ast.Node{start}), ast.NodeFlagsLet),
		binary(l.ctx, l.i, ast.KindGreaterThanEqualsToken, number(l.ctx, "0")),
		factory.NewPostfixUnaryExpression(l.i, ast.KindMinusMinusToken),
		factory.NewBlock(factory.NewNodeList(body), true),
	))
}

// rowBody is the body of callback, run once per row, with every view use lowered and its own returns and var
// declarations transplanted. A parameter pattern binds with `let` ahead of the body, which then runs in a block of
// its own, so the bindings stay assignable as parameters are and their defaults see the enclosing scope but not the
// names the body declares.
func (l *loop) rowBody(callback *ast.Node) []*ast.Node {
	var visitor *ast.NodeVisitor
	visitor = l.ctx.NewNodeVisitor(func(node *ast.Node) *ast.Node {
		if r, ok := bodyRule(node); ok && inOwnCode(node, callback, r) {
			l.applied.add(r)
		}
		if use, ok := l.lowering[node]; ok {
			return l.lower(visitor, node, use)
		}
		if rewritten, ok := l.transplant.visit(visitor, node); ok {
			return rewritten
		}
		return visitor.VisitEachChild(node)
	})
	l.noteCallback(callback)
	var bindings []*ast.Node
	for _, param := range callback.Parameters() {
		if use, ok := l.lowering[param.Name()]; ok {
			bindings = l.destructure(visitor, param.Name(), use, inParameter)
		}
	}
	statements := bodyStatements(visitor, callback.Body())
	if vars := l.transplant.bindings(callback.Body()); vars != nil {
		statements = slices.Insert(statements, 0, vars)
	}
	if len(bindings) == 0 {
		return statements
	}
	return []*ast.Node{letStatement(l.ctx, bindings...), l.ctx.Factory.NewBlock(l.ctx.Factory.NewNodeList(statements), true)}
}

// noteCallback records the rules of callback's form: an arrow or a function expression, with no parameter or an
// annotated one, and an expression body.
func (l *loop) noteCallback(callback *ast.Node) {
	if callback.Kind == ast.KindArrowFunction {
		l.applied.add(ruleCallbackArrow)
	} else {
		l.applied.add(ruleCallbackFunction)
	}
	params := callback.Parameters()
	if len(params) == 0 {
		l.applied.add(ruleCallbackWithoutParameter)
	} else if params[0].Type() != nil {
		l.applied.add(ruleCallbackTypedParameter)
	}
	if callback.Body().Kind != ast.KindBlock {
		l.applied.add(ruleExpressionBody)
	}
}

// lower returns the lowering of node, the node of use, visiting the parts of it the body evaluates with visitor.
// It mirrors the view's accessors in buildView (src/entity/each.ts): the id getter reads the entity array, an
// optional slot's getter tests the row's presence bit, a required tag is `true`, and fieldAccessorsFor
// (src/entity/each.ts) reads and writes a column at the bound row, decoding and encoding booleans as 1/0.
// An alias holds its slot's presence, tested once at its declaration, in place of the field record,
// whose accessors never test the bit again.
//
// It panics on a use this version has no lowering for.
func (l *loop) lower(visitor *ast.NodeVisitor, node *ast.Node, use facts.ViewUse) *ast.Node {
	factory := l.ctx.Factory
	l.noteUse(node, use)
	switch use.Kind {
	case facts.UseID:
		return l.atRow(l.entityArray())
	case facts.UseFieldRead:
		return l.read(use, l.guardedColumn(use, node.Expression()))
	case facts.UseOptionalRead:
		read := l.read(use, l.columnArray(use))
		if _, optional := l.slot(use.Comp); !optional {
			return read
		}
		return orUndefined(l.ctx, l.present(use, node.Expression()), read)
	case facts.UseFieldAssign:
		return l.assign(visitor, node, use)
	case facts.UseFieldUpdate:
		return l.update(node, use)
	case facts.UsePresence:
		return l.present(use, node)
	case facts.UseCompare:
		return l.compare(node, use)
	case facts.UseCoalesce:
		coalesce := node.AsBinaryExpression()
		return paren(l.ctx, factory.NewLogicalORExpression(l.present(use, coalesce.Left), visitor.VisitNode(coalesce.Right)))
	case facts.UseTag:
		if _, optional := l.slot(use.Comp); !optional {
			return factory.NewTrueExpression()
		}
		return orUndefined(l.ctx, l.present(use, node), factory.NewTrueExpression())
	case facts.UseAlias:
		return declaration(l.ctx, node.Name(), l.present(use, node.Initializer()))
	case facts.UseDestructure:
		return factory.NewSyntaxList(l.destructure(visitor, node, use, inDeclaration))
	}
	panic(fmt.Sprintf("emit: the view use of %s.%s, kind %d, has no lowering", use.Comp, use.Field, use.Kind))
}

// destructure returns the declarations that bind, in pattern order, the pattern of node, a `const` or `let`
// declaration or the pattern itself, destructuring the view or the data slot of use at site. It mirrors the
// reads the destructuring makes through buildView (src/entity/each.ts): an optional slot's getter tests presence
// once, and the record fieldAccessorsFor (src/entity/each.ts) builds then reads each field's column without
// testing it again.
func (l *loop) destructure(visitor *ast.NodeVisitor, node *ast.Node, use facts.ViewUse, site patternSite) []*ast.Node {
	pattern := node
	if node.Kind == ast.KindVariableDeclaration {
		pattern = node.Name()
		if use.Comp != "" {
			l.applied.add(ruleDestructureSlot)
		}
	}
	var declarations []*ast.Node
	if _, optional := l.slot(use.Comp); optional {
		l.applied.add(ruleDestructureOptionalSlot)
		declarations = append(declarations, l.slotGuard(use))
	}
	for _, element := range pattern.AsBindingPattern().Elements.Nodes {
		declarations = append(declarations, l.bindElement(visitor, element, site)...)
	}
	return declarations
}

// bodyRule returns the transplant rule that node, a node of the callback's body the rewrite moves as written, applies:
// a block-scoped declaration, a function the body creates, this, arguments, new.target, super,
// a label, a break or continue, or a throw.
func bodyRule(node *ast.Node) (Rule, bool) {
	if isLabelStatement(node) {
		return ruleUserLabel, true
	}
	switch node.Kind {
	case ast.KindVariableDeclarationList:
		return ruleBlockScopedDeclaration, node.Flags&ast.NodeFlagsBlockScoped != 0
	case ast.KindClassDeclaration, ast.KindFunctionDeclaration:
		return ruleBlockScopedDeclaration, true
	case ast.KindArrowFunction, ast.KindFunctionExpression, ast.KindMethodDeclaration:
		return ruleClosure, true
	case ast.KindThisKeyword:
		return ruleThis, true
	case ast.KindSuperKeyword:
		return ruleSuper, true
	case ast.KindMetaProperty:
		return ruleNewTarget, node.AsMetaProperty().KeywordToken == ast.KindNewKeyword
	case ast.KindIdentifier:
		isMember := node.Parent.Kind == ast.KindPropertyAccessExpression && node.Parent.Name() == node
		return ruleArguments, node.Text() == "arguments" && !isMember
	case ast.KindThrowStatement:
		return ruleThrow, true
	}
	return 0, false
}

// inOwnCode reports whether node, a node of callback that applies r, applies it as the callback's own code. `this`,
// `arguments`, `super`, and `new.target` are the callback's own outside code that binds its own, and a
// block-scoped declaration, a label, a throw, and a dead-zone read outside any function nested in the callback,
// arrows included.
func inOwnCode(node, callback *ast.Node, r Rule) bool {
	var enters func(child, parent *ast.Node) bool
	switch r {
	case ruleThis, ruleArguments, ruleSuper, ruleNewTarget:
		enters = entersOwnThis
	case ruleBlockScopedDeclaration, ruleUserLabel, ruleThrow, ruleOuterLetDeadZone:
		enters = entersOwnScope
	default:
		return true
	}
	for child := node; child.Parent != nil && child.Parent != callback; child = child.Parent {
		if enters(child, child.Parent) {
			return false
		}
	}
	return true
}

// entersOwnThis reports whether child, a child of parent, is code that binds its own `this`, `arguments`, and
// `new.target`: the parameters or body of a non-arrow function, method, accessor, or constructor, a class field's
// initializer, or a class static block. A member's decorators and computed name are not.
func entersOwnThis(child, parent *ast.Node) bool {
	switch parent.Kind {
	case ast.KindFunctionExpression, ast.KindFunctionDeclaration, ast.KindClassStaticBlockDeclaration:
		return true
	case ast.KindMethodDeclaration, ast.KindGetAccessor, ast.KindSetAccessor, ast.KindConstructor:
		return child == parent.Body() || child.Kind == ast.KindParameter
	case ast.KindPropertyDeclaration:
		return child == parent.Initializer()
	}
	return false
}

// entersOwnScope reports whether child, a child of parent, is code with a function scope of its own: what
// entersOwnThis reports, or the parameters or body of an arrow function.
func entersOwnScope(child, parent *ast.Node) bool {
	return parent.Kind == ast.KindArrowFunction || entersOwnThis(child, parent)
}

// bodyStatements visits the statements of body, a callback's body, with visitor, which may drop a statement or
// replace it with several; an expression body is one expression statement.
func bodyStatements(visitor *ast.NodeVisitor, body *ast.Node) []*ast.Node {
	if body.Kind != ast.KindBlock {
		return []*ast.Node{visitor.Factory.NewExpressionStatement(visitor.VisitNode(body))}
	}
	statements, _ := visitor.VisitSlice(body.Statements())
	return statements
}

// slot returns the presence bit of comp and true when comp is optional in the loop's shape.
func (l *loop) slot(comp string) (uint32, bool) {
	for k, c := range l.shape.Optional {
		if c.Name == comp {
			return 1 << k, true
		}
	}
	return 0, false
}

func (l *loop) storageArray(name string) *ast.Node {
	return l.ctx.Factory.NewPropertyAccessExpression(l.storage, nil, l.ctx.Factory.NewIdentifier(name), ast.NodeFlagsNone)
}

// recordColumn is `record.field`, the column of col read from its component's record.
func (l *loop) recordColumn(col column) *ast.Node {
	return l.ctx.Factory.NewPropertyAccessExpression(l.records[col.comp].name, nil, l.ctx.Factory.NewIdentifier(col.field), ast.NodeFlagsNone)
}

// optimistic generates a name that prints as its base text unless that would collide.
func optimistic() printer.AutoGenerateOptions {
	return printer.AutoGenerateOptions{Flags: printer.GeneratedIdentifierFlagsOptimistic}
}

// member reads the property name of object, with an element access when name is not an identifier.
func member(ctx *printer.EmitContext, object *ast.Node, name string) *ast.Node {
	if identifierName.MatchString(name) {
		return ctx.Factory.NewPropertyAccessExpression(object, nil, ctx.Factory.NewIdentifier(name), ast.NodeFlagsNone)
	}
	return ctx.Factory.NewElementAccessExpression(object, nil, ctx.Factory.NewStringLiteral(name, ast.TokenFlagsNone), ast.NodeFlagsNone)
}

func declaration(ctx *printer.EmitContext, name, initializer *ast.Node) *ast.Node {
	return ctx.Factory.NewVariableDeclaration(name, nil, nil, initializer)
}

func constStatement(ctx *printer.EmitContext, declarations ...*ast.Node) *ast.Node {
	list := ctx.Factory.NewVariableDeclarationList(ctx.Factory.NewNodeList(declarations), ast.NodeFlagsConst)
	return ctx.Factory.NewVariableStatement(nil, list)
}

func letStatement(ctx *printer.EmitContext, declarations ...*ast.Node) *ast.Node {
	list := ctx.Factory.NewVariableDeclarationList(ctx.Factory.NewNodeList(declarations), ast.NodeFlagsLet)
	return ctx.Factory.NewVariableStatement(nil, list)
}

func binary(ctx *printer.EmitContext, left *ast.Node, operator ast.Kind, right *ast.Node) *ast.Node {
	return ctx.Factory.NewBinaryExpression(nil, left, nil, ctx.Factory.NewToken(operator), right)
}

func number(ctx *printer.EmitContext, text string) *ast.Node {
	return ctx.Factory.NewNumericLiteral(text, ast.TokenFlagsNone)
}
