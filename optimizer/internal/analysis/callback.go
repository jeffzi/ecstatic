package analysis

import (
	"cmp"
	"slices"

	"github.com/microsoft/typescript-go/shim/ast"
	"github.com/microsoft/typescript-go/shim/checker"

	"github.com/jeffzi/ecstatic/optimizer/internal/facts"
	"github.com/jeffzi/ecstatic/optimizer/internal/nodes"
	"github.com/jeffzi/ecstatic/optimizer/internal/syntax"
)

// summarizeCallback returns the facts of fn, an arrow function or function
// expression passed inline to site's iteration call, registering the nodes it
// reports in w's table. View references are classified against site's
// shapes, so they must be resolved first. Spawn targets that hazard
// classification resolves add their declaration files to site.
func (w *walker) summarizeCallback(site *facts.Site, fn *ast.Node) *facts.Callback {
	params := fn.Parameters()
	if len(params) > 0 && isThisParameter(params[0]) {
		params = params[1:]
	}
	cb := &facts.Callback{
		Params:    len(params),
		Arrow:     fn.Kind == ast.KindArrowFunction,
		Async:     fn.ModifierFlags()&ast.ModifierFlagsAsync != 0,
		Generator: fn.BodyData().AsteriskToken != nil,
	}
	var view *ast.Symbol
	body := bodyWalker{
		checker: w.checker, roots: w.roots, table: w.table, file: w.file, fn: fn, shapes: site.Shapes,
		aliases: map[*ast.Symbol]string{}, cb: cb,
	}
	if len(params) > 0 {
		cb.FirstParam = paramForm(params[0])
		view = body.bindParam(params[0], cb.FirstParam)
	}
	body.walk(fn.Body(), bodyScope{})
	for _, call := range directEvalCalls(fn, nil) {
		cb.DirectEval = append(cb.DirectEval, w.table.Register(call))
		body.escape(call, facts.EscapeEval)
	}
	slices.SortStableFunc(cb.Escapes, func(a, b facts.ViewEscape) int { return cmp.Compare(a.Pos.Offset, b.Pos.Offset) })
	hazards := hazardWalker{checker: w.checker, roots: w.roots, table: w.table, site: site, view: view}
	for _, param := range params {
		hazards.walk(param)
	}
	hazards.walk(fn.Body())
	cb.Hazards = hazards.points
	if cb.Arrow {
		cb.ExprBody = fn.Body().Kind != ast.KindBlock
		return cb
	}
	local := functionLocalWalker{checker: w.checker, table: w.table}
	if name := fn.Name(); name != nil {
		local.self = resolveSymbol(w.checker, name)
		local.selfName = name.Text()
	}
	for _, param := range params {
		local.walk(param, true)
	}
	local.walk(fn.Body(), true)
	cb.FunctionLocal = local.uses
	return cb
}

// isThisParameter reports whether param is a TypeScript `this` parameter,
// which annotates the function's `this` type and is erased at runtime.
func isThisParameter(param *ast.Node) bool {
	name := param.Name()
	return name.Kind == ast.KindIdentifier && name.Text() == "this"
}

func paramForm(param *ast.Node) facts.ParamForm {
	if param.AsParameterDeclaration().DotDotDotToken != nil || param.Initializer() != nil {
		return facts.ParamOther
	}
	switch param.Name().Kind {
	case ast.KindIdentifier:
		return facts.ParamIdentifier
	case ast.KindObjectBindingPattern:
		return facts.ParamObjectPattern
	default:
		return facts.ParamOther
	}
}

// bindParam binds param, the callback's first parameter, of form form, as
// what the walk classifies references against, and returns the view's symbol:
// nil for an object pattern, whose properties are classified here along with
// the references its defaults make.
func (w *bodyWalker) bindParam(param *ast.Node, form facts.ParamForm) *ast.Symbol {
	switch form {
	case facts.ParamIdentifier:
		w.view = resolveSymbol(w.checker, param.Name())
	case facts.ParamObjectPattern:
		w.pattern = param.Name()
		w.paramNames = map[string]bool{}
		syntax.ForEachBoundName(w.pattern, func(name string) { w.paramNames[name] = true })
		w.classifyPattern(w.pattern, "")
		w.walk(param, bodyScope{})
	}
	return w.view
}

// bodyScope is where the body walk stands: Nested once an iteration
// statement or a switch encloses it, OwnVars inside a class static block,
// which scopes its own `var` declarations.
type bodyScope struct {
	Nested  bool
	OwnVars bool
}

// bodyWalker collects the view references, returns, and `var` declarations
// of a callback's body, walking what the body evaluates. It classifies each
// reference to the view, and to an alias of one of its slots, against the
// site's shapes as a use that lowers or an escape that does not.
type bodyWalker struct {
	checker *checker.Checker
	roots   *PackageRoots
	table   *nodes.Table
	file    *ast.SourceFile
	// fn is the callback; code inside it but in another function is nested.
	fn   *ast.Node
	view *ast.Symbol
	// pattern is the object pattern of the callback's first parameter, which
	// destructures the view in place of a view symbol; nil otherwise.
	pattern    *ast.Node
	paramNames map[string]bool
	// aliases caches, per symbol, the slot it aliases; "" when it is no alias.
	aliases map[*ast.Symbol]string
	cb      *facts.Callback
	// shapes are the site's resolved shapes; with none, every key reads as a
	// data slot holding any field.
	shapes []facts.ArchShape
}

func (w *bodyWalker) walk(node *ast.Node, scope bodyScope) {
	switch node.Kind {
	case ast.KindReturnStatement:
		w.cb.Returns = append(w.cb.Returns, facts.Return{Node: w.table.Register(node), Nested: scope.Nested})
	case ast.KindVariableDeclarationList:
		w.recordVars(node, scope)
	case ast.KindForStatement, ast.KindForInStatement, ast.KindForOfStatement, ast.KindWhileStatement,
		ast.KindDoStatement, ast.KindSwitchStatement:
		scope.Nested = true
	case ast.KindClassStaticBlockDeclaration:
		scope.OwnVars = true
	case ast.KindIdentifier:
		w.recordReference(node)
		return
	}
	w.scanDeferred(node)
	forEachEvaluated(node, func(child *ast.Node) { w.walk(child, scope) })
}

func (w *bodyWalker) recordVars(list *ast.Node, scope bodyScope) {
	if scope.OwnVars || list.Flags&ast.NodeFlagsBlockScoped != 0 {
		return
	}
	for _, declaration := range list.AsVariableDeclarationList().Declarations.Nodes {
		id := w.table.Register(declaration)
		w.cb.VarDecls = append(w.cb.VarDecls, id)
		redeclares := false
		syntax.ForEachBoundName(declaration.Name(), func(name string) { redeclares = redeclares || w.paramNames[name] })
		if redeclares {
			w.cb.ParamRedeclarations = append(w.cb.ParamRedeclarations, id)
		}
	}
}

// scanDeferred records as escapes the references in the parts of node that
// run only when called, which forEachEvaluated leaves out: a nested function,
// and the parts of a class or object-literal member that forEachDeferred
// visits.
func (w *bodyWalker) scanDeferred(node *ast.Node) {
	switch node.Kind {
	case ast.KindArrowFunction, ast.KindFunctionExpression, ast.KindFunctionDeclaration:
		w.scanNested(node, w.nestedLoop(node))
	default:
		forEachDeferred(node, func(part *ast.Node) { w.scanNested(part, nil) })
	}
}

// scanNested records every reference in node's subtree as an escape: an
// EscapeNestedLoop one against loop, the innermost iteration call whose inline
// callback holds node, or an EscapeNested one when loop is nil. Inside such a
// callback, a further function is what its own position makes it.
func (w *bodyWalker) scanNested(node, loop *ast.Node) {
	if ast.IsPartOfTypeNode(node) {
		return
	}
	if node.Kind == ast.KindIdentifier {
		if ref := w.referent(node); ref.view || ref.alias != "" {
			w.nestedEscape(node, loop)
		}
		return
	}
	node.ForEachChild(func(child *ast.Node) bool {
		childLoop := loop
		if loop != nil && ast.IsFunctionLike(child) {
			childLoop = w.nestedLoop(child)
		}
		w.scanNested(child, childLoop)
		return false
	})
}

// nestedEscape records id, a reference inside nested code, as scanNested
// describes.
func (w *bodyWalker) nestedEscape(id, loop *ast.Node) {
	escape := facts.ViewEscape{Pos: nodePosition(w.file, id), Node: w.table.Register(id), Kind: facts.EscapeNested}
	if loop != nil {
		escape.Kind, escape.Loop = facts.EscapeNestedLoop, w.table.Register(loop)
	}
	w.cb.Escapes = append(w.cb.Escapes, escape)
}

// nestedLoop is the iteration call fn is written inline as the callback of,
// and nil when fn is any other function.
func (w *bodyWalker) nestedLoop(fn *ast.Node) *ast.Node {
	if call := fn.Parent; call != nil && call.Kind == ast.KindCallExpression {
		if op, _, ok := recognize(w.checker, w.roots, call); ok && inlineCallback(call, op) == fn {
			return call
		}
	}
	return nil
}

// referent is what an identifier reads: the view, an alias of the slot
// alias names, or neither.
type referent struct {
	alias string
	view  bool
}

func (w *bodyWalker) referent(id *ast.Node) referent {
	if (w.view == nil && w.pattern == nil) || isNamePosition(id) {
		return referent{}
	}
	switch symbol := resolveSymbol(w.checker, id); symbol {
	case nil:
		return referent{}
	case w.view:
		return referent{view: true}
	default:
		return referent{alias: w.aliasOf(symbol)}
	}
}

// isNamePosition reports whether id names a property or declares a binding
// rather than reading one. A shorthand property both declares a property and
// reads a binding, so it reads.
func isNamePosition(id *ast.Node) bool {
	switch parent := id.Parent; parent.Kind {
	case ast.KindPropertyAccessExpression:
		return parent.Name() == id
	case ast.KindShorthandPropertyAssignment:
		return false
	default:
		return ast.IsDeclarationNameOrImportPropertyName(id)
	}
}

// aliasOf returns the slot symbol aliases, "" when it is no alias.
func (w *bodyWalker) aliasOf(symbol *ast.Symbol) string {
	if comp, ok := w.aliases[symbol]; ok {
		return comp
	}
	comp, _ := w.aliasSlot(valueDeclaration(symbol))
	w.aliases[symbol] = comp
	return comp
}

// aliasSlot returns the slot that decl aliases and true when decl is
// `const p = e.C` or `const p = e.C!` for a data slot C, `e.C` spelled as
// viewKey reads it, or the property `C: p` or `C` of a pattern destructuring
// the view, declared by the callback's own code rather than by a nested
// function.
func (w *bodyWalker) aliasSlot(decl *ast.Node) (string, bool) {
	if decl != nil && decl.Kind == ast.KindBindingElement {
		return w.patternSlot(decl)
	}
	if decl == nil || decl.Kind != ast.KindVariableDeclaration || decl.Name().Kind != ast.KindIdentifier ||
		decl.Initializer() == nil || decl.Parent.Flags&ast.NodeFlagsBlockScoped != ast.NodeFlagsConst {
		return "", false
	}
	comp, ok := w.viewKey(syntax.SkipWrappers(decl.Initializer()))
	if info, isSlot := w.slot(comp); !ok || comp == idKey || !isSlot || info.tag || w.inNestedCode(decl) {
		return "", false
	}
	return comp, true
}

// viewKey returns the key that access reads from the view and true when
// access is `e.K`, or `e["C"]` whose string literal names a component of
// the shape: the only way to reach a component whose name is no identifier.
// An optional access, and any other expression, reads no key.
func (w *bodyWalker) viewKey(access *ast.Node) (string, bool) {
	isAccess := access.Kind == ast.KindPropertyAccessExpression || access.Kind == ast.KindElementAccessExpression
	if !isAccess || access.QuestionDotToken() != nil || !w.isView(syntax.SkipWrappers(access.Expression())) {
		return "", false
	}
	if access.Kind == ast.KindPropertyAccessExpression {
		return access.Name().Text(), true
	}
	key, literal := literalElementKey(access)
	if !literal || key == idKey {
		return "", false
	}
	_, ok := w.slot(key)
	return key, ok
}

// patternSlot returns the data slot that element binds to an identifier and
// true when element is a property, with no default, of a pattern destructuring
// the view.
func (w *bodyWalker) patternSlot(element *ast.Node) (string, bool) {
	binding := element.AsBindingElement()
	if binding.DotDotDotToken != nil || binding.Initializer != nil || element.Name().Kind != ast.KindIdentifier ||
		!w.isViewPattern(element.Parent) {
		return "", false
	}
	comp, named := patternKey(element)
	if info, ok := w.slot(comp); !named || comp == idKey || !ok || info.tag {
		return "", false
	}
	return comp, true
}

// isViewPattern reports whether pattern destructures the view: it is the
// callback's parameter pattern, or the pattern of a declaration in the
// callback's own code that destructuredPattern lowers, whose value is the
// view.
func (w *bodyWalker) isViewPattern(pattern *ast.Node) bool {
	if pattern == w.pattern {
		return true
	}
	decl := pattern.Parent
	return decl.Kind == ast.KindVariableDeclaration && decl.Initializer() != nil && destructuredPattern(decl.Initializer()) == pattern &&
		w.isView(syntax.SkipWrappers(decl.Initializer())) && !w.inNestedCode(decl)
}

// destructuredPattern returns the object pattern of the `const` or `let`
// declaration whose value is expr, and nil when expr is the value of any other
// declaration or assignment.
func destructuredPattern(expr *ast.Node) *ast.Node {
	decl := expr.Parent
	if decl.Kind != ast.KindVariableDeclaration || decl.Initializer() != expr || decl.Name().Kind != ast.KindObjectBindingPattern ||
		decl.Parent.Kind != ast.KindVariableDeclarationList {
		return nil
	}
	if scoped := decl.Parent.Flags & ast.NodeFlagsBlockScoped; scoped != ast.NodeFlagsLet && scoped != ast.NodeFlagsConst {
		return nil
	}
	return decl.Name()
}

// classifyPattern records pattern, an object pattern destructuring the view
// when comp is empty and the data slot comp otherwise, as a use, at its
// declaration when a `const` or `let` declares it, then each of its
// properties, in pattern order, as a use or an escape.
func (w *bodyWalker) classifyPattern(pattern *ast.Node, comp string) {
	node := pattern
	if pattern.Parent.Kind == ast.KindVariableDeclaration {
		node = pattern.Parent
	}
	w.use(node, facts.ViewUse{Kind: facts.UseDestructure, Comp: comp})
	for _, element := range pattern.AsBindingPattern().Elements.Nodes {
		key, named := patternKey(element)
		switch {
		case element.AsBindingElement().DotDotDotToken != nil:
			w.escape(element, facts.EscapeDestructure)
		case !named:
			w.escape(element, facts.EscapeComputed)
		case comp == "":
			w.classifyPatternSlot(element, key)
		default:
			w.classifyPatternField(element, comp, key)
		}
	}
}

// classifyPatternSlot records element, the property key of a pattern
// destructuring the view.
func (w *bodyWalker) classifyPatternSlot(element *ast.Node, key string) {
	info, ok := w.slot(key)
	name := element.Name()
	switch {
	case element.Initializer() != nil:
		w.escape(element, facts.EscapeDestructure)
	case key == idKey:
		w.use(element, facts.ViewUse{Kind: facts.UseID})
	case !ok:
		w.escape(element, facts.EscapeKey)
	case info.tag:
		w.use(element, facts.ViewUse{Kind: facts.UseTag, Comp: key})
	case name.Kind == ast.KindIdentifier:
		w.use(element, facts.ViewUse{Kind: facts.UseAlias, Comp: key})
	case name.Kind == ast.KindObjectBindingPattern:
		w.classifyPattern(name, key)
	default:
		w.escape(element, facts.EscapeDestructure)
	}
}

// classifyPatternField records element, the property key of a pattern
// destructuring the data slot comp. Whatever element binds the field to is
// plain code on the field's value.
func (w *bodyWalker) classifyPatternField(element *ast.Node, comp, key string) {
	info, _ := w.slot(comp)
	field, ok := info.field(key)
	if !ok {
		w.escape(element, facts.EscapeKey)
		return
	}
	w.use(element, facts.ViewUse{Kind: facts.UseFieldRead, Comp: comp, Field: field.Name})
}

// inNestedCode reports whether node lies in code that runs only when called:
// a function nested in the callback, or an instance field's initializer.
func (w *bodyWalker) inNestedCode(node *ast.Node) bool {
	for parent := node.Parent; parent != nil && parent != w.fn; node, parent = parent, parent.Parent {
		if ast.IsFunctionLike(parent) {
			return true
		}
		if isInstanceInitializer(parent, node) {
			return true
		}
	}
	return false
}

const idKey = "id"

// recordReference records the use or escape of id when it reads the view or
// an alias.
func (w *bodyWalker) recordReference(id *ast.Node) {
	switch ref := w.referent(id); {
	case ref.view:
		w.classifyView(id)
	case ref.alias != "":
		w.classifySlot(id, ref.alias, true)
	}
}

// classifyView records the reference id makes to the view by the expression
// around it, past any parentheses and non-null assertions: `e.K`, `e[...]`,
// or the value a pattern destructures. Any other expression, `e?.K` included,
// is an EscapeView.
func (w *bodyWalker) classifyView(id *ast.Node) {
	outer := outermostWrapper(id)
	switch up := outer.Parent; {
	case up.Kind == ast.KindPropertyAccessExpression && up.Expression() == outer && up.QuestionDotToken() == nil:
		w.classifyKey(up)
	case up.Kind == ast.KindElementAccessExpression && up.Expression() == outer:
		if comp, ok := w.viewKey(up); ok {
			w.classifySlot(up, comp, false)
		} else {
			w.escape(up, facts.EscapeComputed)
		}
	case destructuredPattern(outer) != nil:
		w.classifyPattern(destructuredPattern(outer), "")
	case isDestructured(outer):
		w.escape(outer, facts.EscapeDestructure)
	default:
		w.escape(id, facts.EscapeView)
	}
}

// classifyKey records the reference access, `e.K`, makes to the view.
func (w *bodyWalker) classifyKey(access *ast.Node) {
	key := access.Name().Text()
	switch _, ok := w.slot(key); {
	case key == idKey && isWriteTarget(access):
		w.escape(access, facts.EscapeSlotAssign)
	case key == idKey:
		w.use(access, facts.ViewUse{Kind: facts.UseID})
	case !ok:
		w.escape(access, facts.EscapeKey)
	default:
		w.classifySlot(access, key, false)
	}
}

// classifySlot records the reference slot makes to the slot comp: slot is
// `e.C` or, when alias is set, an identifier aliasing it.
func (w *bodyWalker) classifySlot(slot *ast.Node, comp string, alias bool) {
	info, _ := w.slot(comp)
	outer := outermostWrapper(slot)
	up := outer.Parent
	use := facts.ViewUse{Comp: comp, Alias: alias}
	switch {
	case up.Kind == ast.KindPropertyAccessExpression && up.Expression() == outer:
		w.classifySlotKey(up, info, use)
	case up.Kind == ast.KindElementAccessExpression && up.Expression() == outer:
		w.escape(up, facts.EscapeComputed)
	case isTestPosition(outer):
		use.Kind = facts.UsePresence
		w.use(outer, use)
	case w.isNullishComparison(up):
		use.Kind = facts.UseCompare
		w.use(up, use)
	case isBinary(up, ast.KindQuestionQuestionToken) && up.AsBinaryExpression().Left == outer && isTestPosition(up):
		use.Kind = facts.UseCoalesce
		w.use(up, use)
	case isWriteTarget(outer):
		w.escape(outer, facts.EscapeSlotAssign)
	case info.tag:
		use.Kind = facts.UseTag
		w.use(outer, use)
	case !alias && up.Kind == ast.KindVariableDeclaration && up.Initializer() == outer && w.isAlias(up):
		use.Kind = facts.UseAlias
		w.use(up, use)
	case !alias && destructuredPattern(outer) != nil:
		w.classifyPattern(destructuredPattern(outer), comp)
	case !alias && isDestructured(outer):
		w.escape(outer, facts.EscapeDestructure)
	default:
		w.escape(outer, facts.EscapeSlotValue)
	}
}

func (w *bodyWalker) isAlias(decl *ast.Node) bool {
	_, ok := w.aliasSlot(decl)
	return ok
}

// classifySlotKey records the reference access, `S.f` on a slot S, makes to
// the field f, with use holding the slot's component and alias flag.
func (w *bodyWalker) classifySlotKey(access *ast.Node, info slotInfo, use facts.ViewUse) {
	field, ok := info.field(access.Name().Text())
	if !ok {
		w.escape(access, facts.EscapeKey)
		return
	}
	use.Field = field.Name
	if access.QuestionDotToken() == nil {
		w.classifyField(access, field, use)
		return
	}
	if parent := access.Parent; parent.Flags&ast.NodeFlagsOptionalChain != 0 && parent.Expression() == access {
		w.escape(access, facts.EscapeChain)
		return
	}
	use.Kind = facts.UseOptionalRead
	w.use(access, use)
}

// classifyField records the reference access, a field `S.f`, makes by the
// position it stands in.
func (w *bodyWalker) classifyField(access *ast.Node, field facts.Field, use facts.ViewUse) {
	outer := syntax.OutermostParens(access)
	up := outer.Parent
	switch {
	case isPatternTarget(outer) || up.Kind == ast.KindDeleteExpression:
		w.escape(access, facts.EscapeTarget)
	case up.Kind == ast.KindBinaryExpression && isAssignment(up.AsBinaryExpression().OperatorToken.Kind) && up.AsBinaryExpression().Left == outer:
		if _, arithmetic := syntax.ArithmeticOperator(up.AsBinaryExpression().OperatorToken.Kind); field.Kind == facts.FieldBoolean && arithmetic {
			w.escape(access, facts.EscapeBooleanArithmetic)
			return
		}
		use.Kind = facts.UseFieldAssign
		w.use(up, use)
	case isUpdateOf(up, outer):
		if field.Kind == facts.FieldBoolean {
			w.escape(access, facts.EscapeBooleanArithmetic)
			return
		}
		use.Kind = facts.UseFieldUpdate
		w.use(up, use)
	case isCallee(access):
		w.escape(access, facts.EscapeFieldCall)
	default:
		use.Kind = facts.UseFieldRead
		w.use(access, use)
	}
}

// isCallee reports whether expr is the callee of a call or a tagged
// template, through the parentheses and the type wrappers TypeScript erases,
// none of which detach the callee from its receiver: the call runs with the
// receiver of expr as `this`.
func isCallee(expr *ast.Node) bool {
	expr = outermostErased(expr)
	up := expr.Parent
	return (up.Kind == ast.KindCallExpression || up.Kind == ast.KindTaggedTemplateExpression) && up.Expression() == expr
}

// isNullishComparison reports whether node compares an operand with `null`
// or the global `undefined` by `===`, `!==`, `==`, or `!=`.
func (w *bodyWalker) isNullishComparison(node *ast.Node) bool {
	if node.Kind != ast.KindBinaryExpression {
		return false
	}
	binary := node.AsBinaryExpression()
	switch binary.OperatorToken.Kind {
	case ast.KindEqualsEqualsEqualsToken, ast.KindExclamationEqualsEqualsToken, ast.KindEqualsEqualsToken,
		ast.KindExclamationEqualsToken:
		return w.isNullish(binary.Left) || w.isNullish(binary.Right)
	default:
		return false
	}
}

func (w *bodyWalker) isNullish(expr *ast.Node) bool {
	expr = syntax.SkipWrappers(expr)
	return expr.Kind == ast.KindNullKeyword || isGlobalValue(w.checker, expr, "undefined")
}

func (w *bodyWalker) use(node *ast.Node, use facts.ViewUse) {
	use.Node = w.table.Register(node)
	w.cb.ViewUses = append(w.cb.ViewUses, use)
}

func (w *bodyWalker) escape(node *ast.Node, kind facts.EscapeKind) {
	w.cb.Escapes = append(w.cb.Escapes, facts.ViewEscape{Pos: nodePosition(w.file, node), Node: w.table.Register(node), Kind: kind})
}

// slotInfo is what every shape of a site holds under one view key.
type slotInfo struct {
	// comps holds the key's component in each shape; empty when no shape
	// resolved.
	comps []facts.Component
	tag   bool
}

// slot returns what the shapes hold under the view key name, and false when
// some shape holds no component of that name or the shapes disagree on
// whether it is a tag.
func (w *bodyWalker) slot(name string) (slotInfo, bool) {
	info := slotInfo{}
	for i, shape := range w.shapes {
		comp, ok := shape.Component(name)
		if !ok || (i > 0 && info.tag != (len(comp.Fields) == 0)) {
			return slotInfo{}, false
		}
		info.tag = len(comp.Fields) == 0
		info.comps = append(info.comps, comp)
	}
	return info, true
}

// field returns the slot's field named name, with its kind as the first
// shape's component declares it, and false when some shape's component lacks
// it. With no shape resolved, every name is a field of unknown kind.
func (s slotInfo) field(name string) (facts.Field, bool) {
	found := facts.Field{Name: name}
	for n, comp := range s.comps {
		field, ok := comp.Field(name)
		if !ok {
			return facts.Field{}, false
		}
		if n == 0 {
			found = field
		}
	}
	return found, true
}

func (w *bodyWalker) isView(node *ast.Node) bool {
	return isViewReference(w.checker, w.view, node)
}

func isViewReference(c *checker.Checker, view *ast.Symbol, node *ast.Node) bool {
	return view != nil && node.Kind == ast.KindIdentifier && resolveSymbol(c, node) == view
}

// directEvalCalls appends to calls every direct `eval` call in node's subtree,
// nested functions included, in source order. Strict code, which modules
// always are, cannot bind the name eval, so a plain call of it is always the
// global's direct form, also through the parentheses, which keep the
// reference, and the type wrappers TypeScript erases; an optional call is
// indirect.
func directEvalCalls(node *ast.Node, calls []*ast.Node) []*ast.Node {
	if node.Kind == ast.KindCallExpression && node.QuestionDotToken() == nil {
		if callee := skipErased(node.Expression()); callee.Kind == ast.KindIdentifier && callee.Text() == "eval" {
			calls = append(calls, node)
		}
	}
	node.ForEachChild(func(child *ast.Node) bool {
		calls = directEvalCalls(child, calls)
		return false
	})
	return calls
}
