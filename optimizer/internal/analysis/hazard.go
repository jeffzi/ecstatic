package analysis

import (
	"slices"

	"github.com/microsoft/typescript-go/shim/ast"
	"github.com/microsoft/typescript-go/shim/checker"

	"github.com/jeffzi/ecstatic/optimizer/internal/facts"
	"github.com/jeffzi/ecstatic/optimizer/internal/nodes"
	"github.com/jeffzi/ecstatic/optimizer/internal/syntax"
)

// hazardWalker collects the hazard points of a callback by an
// allowlist: a node is safe only when it is listed here as one that cannot run
// user code, and every other node is a hazard point. User code can grow the
// iterated storage, which replaces its arrays, so a single hazard point keeps
// the inlined loop from holding any array across an access.
type hazardWalker struct {
	checker *checker.Checker
	roots   *PackageRoots
	table   *nodes.Table
	site    *facts.Site
	view    *ast.Symbol
	points  []facts.NodeID
}

func (h *hazardWalker) walk(node *ast.Node) {
	if h.classify(node) {
		forEachEvaluated(node, h.walk)
	}
}

func (h *hazardWalker) record(node *ast.Node) {
	h.points = append(h.points, h.table.Register(node))
}

func (h *hazardWalker) recordIf(node *ast.Node, hazard bool) {
	if hazard {
		h.record(node)
	}
}

// classify records node when it is a hazard point and reports whether the
// nodes it evaluates are walked. A token (a literal, an identifier, a keyword,
// or punctuation) runs nothing. A view use reads the storage's columns, which
// runs no user code, so its operands are not classified as property reads.
func (h *hazardWalker) classify(node *ast.Node) bool {
	if ast.IsTokenKind(node.Kind) {
		return false
	}
	switch node.Kind {
	case ast.KindPropertyAccessExpression:
		if h.isViewPart(node) {
			return false
		}
		h.recordIf(node, node.Name().Kind != ast.KindIdentifier || h.readRuns(node.Expression(), node.Name().Text()))
	case ast.KindElementAccessExpression:
		if h.isViewPart(node) {
			return false
		}
		h.recordIf(node, h.elementReadRuns(node))
	case ast.KindCallExpression:
		h.recordIf(node, !h.safeCall(node))
	case ast.KindBinaryExpression:
		h.classifyBinary(node)
	case ast.KindPrefixUnaryExpression:
		prefix := node.AsPrefixUnaryExpression()
		h.recordIf(node, prefix.Operator != ast.KindExclamationToken && !h.primitive(prefix.Operand))
	case ast.KindPostfixUnaryExpression:
		h.recordIf(node, !h.primitive(node.AsPostfixUnaryExpression().Operand))
	case ast.KindTemplateSpan, ast.KindComputedPropertyName:
		// Converting an object to a string or a property key calls its toString or valueOf.
		h.recordIf(node.Expression(), !h.primitive(node.Expression()))
	case ast.KindBindingElement:
		h.recordIf(node, h.bindingReadRuns(node))
	case ast.KindVariableDeclarationList:
		h.recordIf(node, node.Flags&ast.NodeFlagsUsing != 0)
	default:
		h.recordIf(node, !isSafeKind(node.Kind))
	}
	return true
}

// isSafeKind reports whether a node of kind runs no user code beyond what
// its children run: statements and control flow, literals built from their
// elements, declarations, functions and classes (their bodies run only when
// called), and type-only wrappers.
func isSafeKind(kind ast.Kind) bool {
	switch kind {
	case ast.KindBlock, ast.KindVariableStatement, ast.KindVariableDeclaration, ast.KindExpressionStatement,
		ast.KindIfStatement, ast.KindDoStatement, ast.KindWhileStatement, ast.KindForStatement,
		ast.KindContinueStatement, ast.KindBreakStatement, ast.KindReturnStatement, ast.KindLabeledStatement,
		ast.KindSwitchStatement, ast.KindCaseBlock, ast.KindCaseClause, ast.KindDefaultClause,
		ast.KindThrowStatement, ast.KindTryStatement, ast.KindCatchClause, ast.KindEmptyStatement,
		ast.KindParenthesizedExpression, ast.KindConditionalExpression, ast.KindArrayLiteralExpression,
		ast.KindObjectLiteralExpression, ast.KindPropertyAssignment, ast.KindShorthandPropertyAssignment,
		ast.KindTemplateExpression, ast.KindArrowFunction, ast.KindFunctionExpression, ast.KindFunctionDeclaration,
		ast.KindClassDeclaration, ast.KindClassExpression, ast.KindHeritageClause, ast.KindExpressionWithTypeArguments,
		ast.KindMethodDeclaration, ast.KindGetAccessor, ast.KindSetAccessor, ast.KindConstructor,
		ast.KindPropertyDeclaration, ast.KindClassStaticBlockDeclaration, ast.KindObjectBindingPattern,
		ast.KindParameter, ast.KindAsExpression, ast.KindSatisfiesExpression, ast.KindNonNullExpression,
		ast.KindTypeAssertionExpression, ast.KindTypeOfExpression, ast.KindVoidExpression, ast.KindMetaProperty,
		ast.KindInterfaceDeclaration, ast.KindTypeAliasDeclaration:
		return true
	default:
		return false
	}
}

// isViewPart reports whether access is `e.K` or `e.C.f` on the view, in the
// receiver forms the body walker reads as view uses: through parentheses and
// non-null assertions, and with `e["C"]` for `e.C`.
func (h *hazardWalker) isViewPart(access *ast.Node) bool {
	if h.isViewKey(access) {
		return true
	}
	return access.Kind == ast.KindPropertyAccessExpression && h.isViewKey(syntax.SkipWrappers(access.Expression()))
}

// isViewKey reports whether access is `e.K`, or `e["K"]` with a string
// literal key, on the view.
func (h *hazardWalker) isViewKey(access *ast.Node) bool {
	isKey := access.Kind == ast.KindPropertyAccessExpression
	if access.Kind == ast.KindElementAccessExpression {
		_, isKey = literalElementKey(access)
	}
	return isKey && isViewReference(h.checker, h.view, syntax.SkipWrappers(access.Expression()))
}

// classifyBinary records a binary expression that can run user code: `in`
// and `instanceof` (a proxy trap, Symbol.hasInstance), an array or object
// destructuring assignment (the iterator protocol, or reads through getters),
// and an operator that converts an object operand to a primitive. Assignment,
// the logical operators, the comma, and strict equality convert nothing, and
// neither does loose equality with `null` or `undefined`, which compares
// without converting the other operand: a presence test of an optional slot,
// `e.C == null`, stays hazard-free.
func (h *hazardWalker) classifyBinary(node *ast.Node) {
	binary := node.AsBinaryExpression()
	switch operator := binary.OperatorToken.Kind; operator {
	case ast.KindInstanceOfKeyword, ast.KindInKeyword:
		h.record(node)
	case ast.KindEqualsToken:
		h.recordIf(binary.Left, isDestructuringAssignment(node))
	case ast.KindAmpersandAmpersandToken, ast.KindBarBarToken, ast.KindQuestionQuestionToken, ast.KindCommaToken,
		ast.KindEqualsEqualsEqualsToken, ast.KindExclamationEqualsEqualsToken, ast.KindAmpersandAmpersandEqualsToken,
		ast.KindBarBarEqualsToken, ast.KindQuestionQuestionEqualsToken:
	case ast.KindEqualsEqualsToken, ast.KindExclamationEqualsToken:
		h.recordIf(node, !h.nullish(binary.Left) && !h.nullish(binary.Right) &&
			(!h.primitive(binary.Left) || !h.primitive(binary.Right)))
	default:
		h.recordIf(node, !h.primitive(binary.Left) || !h.primitive(binary.Right))
	}
}

// nullish reports whether expr's static type holds only `null` and
// `undefined`.
func (h *hazardWalker) nullish(expr *ast.Node) bool {
	return isNullishType(h.checker.GetTypeAtLocation(expr))
}

func isNullishType(t *checker.Type) bool {
	if t.Flags()&checker.TypeFlagsUnion != 0 {
		return !slices.ContainsFunc(t.Types(), func(member *checker.Type) bool { return !isNullishType(member) })
	}
	return t.Flags()&(checker.TypeFlagsNullable|checker.TypeFlagsVoid) != 0
}

// elementReadRuns reports whether an element access can run user code: a
// key that is not primitive converts through its toString or valueOf, and the
// property a key names can be an accessor of the receiver's type. A literal
// key names one property; any other key can name every property.
func (h *hazardWalker) elementReadRuns(access *ast.Node) bool {
	key := access.AsElementAccessExpression().ArgumentExpression
	if !h.primitive(key) {
		return true
	}
	if name, literal := literalElementKey(access); literal {
		return h.readRuns(access.Expression(), name)
	}
	return anyReadRuns(h.checker, h.checker.GetTypeAtLocation(access.Expression()))
}

// anyReadRuns reports whether reading some property of a value of type t can
// run user code: t declares an accessor, or t is `any` or `unknown`.
func anyReadRuns(c *checker.Checker, t *checker.Type) bool {
	if t.Flags()&checker.TypeFlagsAnyOrUnknown != 0 {
		return true
	}
	if t.Flags()&(checker.TypeFlagsUnion|checker.TypeFlagsIntersection) != 0 {
		return slices.ContainsFunc(t.Types(), func(member *checker.Type) bool { return anyReadRuns(c, member) })
	}
	return slices.ContainsFunc(propertiesOfType(c, c.GetApparentType(t)), isAccessorSymbol)
}

// primitive reports whether expr's static type holds only primitives, which
// convert without running user code.
func (h *hazardWalker) primitive(expr *ast.Node) bool {
	return isPrimitiveType(h.checker, h.checker.GetTypeAtLocation(expr))
}

// isPrimitiveType reports whether every value of t is a primitive: a union
// of primitive types, or an intersection with one, such as a branded number.
func isPrimitiveType(c *checker.Checker, t *checker.Type) bool {
	switch {
	case t.Flags()&checker.TypeFlagsUnion != 0:
		return !slices.ContainsFunc(t.Types(), func(member *checker.Type) bool { return !isPrimitiveType(c, member) })
	case t.Flags()&checker.TypeFlagsIntersection != 0:
		return slices.ContainsFunc(t.Types(), func(member *checker.Type) bool { return isPrimitiveType(c, member) })
	default:
		return t.Flags()&(checker.TypeFlagsPrimitive|checker.TypeFlagsNever) != 0
	}
}

// readRuns reports whether reading or writing property name of receiver can
// run user code: the receiver's type declares the property as an accessor, or
// the type is `any` or `unknown` and so declares nothing.
func (h *hazardWalker) readRuns(receiver *ast.Node, name string) bool {
	return typeReadRuns(h.checker, h.checker.GetTypeAtLocation(receiver), name)
}

func typeReadRuns(c *checker.Checker, t *checker.Type, name string) bool {
	if t.Flags()&checker.TypeFlagsAnyOrUnknown != 0 {
		return true
	}
	if t.Flags()&(checker.TypeFlagsUnion|checker.TypeFlagsIntersection) != 0 {
		return slices.ContainsFunc(t.Types(), func(member *checker.Type) bool { return typeReadRuns(c, member, name) })
	}
	return isAccessorProperty(c, c.GetApparentType(t), name)
}

// bindingReadRuns reports whether an element of an object destructuring
// pattern can run user code as it reads its property: a rest element reads
// every property, and a computed key is not known statically.
func (h *hazardWalker) bindingReadRuns(element *ast.Node) bool {
	pattern := element.Parent
	if pattern.Kind != ast.KindObjectBindingPattern {
		return false
	}
	if element.AsBindingElement().DotDotDotToken != nil {
		return true
	}
	key, named := patternKey(element)
	if !named {
		return true
	}
	return typeReadRuns(h.checker, h.checker.GetTypeAtLocation(pattern), key)
}

// safeCall reports whether call is on the allowlist: a method of the global
// Math, or an ecstatic op that never replaces the iterated storage's arrays
// and whose object arguments cannot run a getter at the depth it reads them.
// spawn and spawnMany qualify only into a storage whose shape key differs
// from every iterated one.
func (h *hazardWalker) safeCall(call *ast.Node) bool {
	if callee := call.Expression(); callee.Kind == ast.KindPropertyAccessExpression &&
		isGlobalValue(h.checker, callee.Expression(), "Math") {
		return true
	}
	op, _, ok := recognize(h.checker, h.roots, call)
	if !ok {
		return false
	}
	rule, ok := argumentReads(op)
	if !ok {
		return false
	}
	args := call.Arguments()
	if (op == facts.OpSpawn || op == facts.OpSpawnMany) && !h.spawnsElsewhere(args[0]) {
		return false
	}
	for i := rule.from; i < len(args); i++ {
		if !rule.safe(h.checker, h.checker.GetTypeAtLocation(args[i])) {
			return false
		}
	}
	return true
}

// spawnsElsewhere reports whether storage, a spawn target, resolves to a
// shape whose key differs from that of every storage the callback iterates.
func (h *hazardWalker) spawnsElsewhere(storage *ast.Node) bool {
	r := shapeResolver{checker: h.checker, site: h.site}
	target, ok := r.storageShape(r.storageType(storage))
	if !ok || len(h.site.Shapes) == 0 {
		return false
	}
	key := target.Key()
	return !slices.ContainsFunc(h.site.Shapes, func(shape facts.ArchShape) bool { return shape.Key() == key })
}

// reads is how an ecstatic op reads its arguments: from index from on, the
// properties of each argument, to depth levels, or at every depth when clone
// is set, as setResource's deep clone of its value does.
type reads struct {
	from  int
	depth int
	clone bool
}

// safe reports whether reading an argument of type t runs no user code.
func (r reads) safe(c *checker.Checker, t *checker.Type) bool {
	if r.clone {
		return cloneSafe(c, t, map[*checker.Type]bool{})
	}
	return dataOnly(c, t, r.depth)
}

// argumentReads returns how op reads its object arguments, and false when op
// is not on the allowlist: register, destroyWorld, and every other op not
// listed may replace a storage's arrays.
func argumentReads(op facts.Op) (reads, bool) {
	switch op {
	case facts.OpGet, facts.OpHas, facts.OpHasAny, facts.OpAlive, facts.OpDisable, facts.OpDisableMany,
		facts.OpGetTarget, facts.OpUnlink, facts.OpGetResource, facts.OpResetResource, facts.OpGetSources,
		facts.OpHasSources, facts.OpCountSources, facts.OpDespawn, facts.OpDespawnMany:
		return reads{}, true
	case facts.OpSet:
		return reads{from: 3, depth: 1}, true
	case facts.OpLink:
		return reads{from: 4, depth: 1}, true
	case facts.OpEnable:
		return reads{from: 2, depth: 2}, true
	case facts.OpEnableMany, facts.OpSpawn:
		return reads{from: 1, depth: 2}, true
	case facts.OpSpawnMany:
		return reads{from: 2, depth: 2}, true
	case facts.OpSetResource:
		return reads{from: 2, clone: true}, true
	default:
		return reads{}, false
	}
}

// dataOnly reports whether reading the properties of a value of type t, to
// depth levels, runs no getter: every property the type declares at those
// levels is a data property.
func dataOnly(c *checker.Checker, t *checker.Type, depth int) bool {
	if depth == 0 || isPrimitiveType(c, t) {
		return true
	}
	if t.Flags()&checker.TypeFlagsAnyOrUnknown != 0 {
		return false
	}
	if t.Flags()&(checker.TypeFlagsUnion|checker.TypeFlagsIntersection) != 0 {
		return !slices.ContainsFunc(t.Types(), func(member *checker.Type) bool { return !dataOnly(c, member, depth) })
	}
	for _, property := range propertiesOfType(c, c.GetApparentType(t)) {
		if isAccessorSymbol(property) || !dataOnly(c, typeOfSymbol(c, property), depth-1) {
			return false
		}
	}
	return true
}

// cloneSafe reports whether setResource's deep clone of a value of type t
// runs no user code (src/resource.ts, cloneUnknown): every value it reaches is
// a primitive, a function, which the clone keeps by reference, or a plain
// object whose properties are data properties. An array, a tuple, a Map or
// Set, a Date, and any other class instance or named object type are hazards:
// the clone iterates the containers, and a named type may be implemented by
// a class whose methods it calls. seen holds the object types already
// walked, so a recursive type ends the walk.
func cloneSafe(c *checker.Checker, t *checker.Type, seen map[*checker.Type]bool) bool {
	if isPrimitiveType(c, t) || seen[t] {
		return true
	}
	if t.Flags()&checker.TypeFlagsAnyOrUnknown != 0 {
		return false
	}
	if t.Flags()&(checker.TypeFlagsUnion|checker.TypeFlagsIntersection) != 0 {
		return !slices.ContainsFunc(t.Types(), func(member *checker.Type) bool { return !cloneSafe(c, member, seen) })
	}
	if len(c.GetSignaturesOfType(t, checker.SignatureKindCall)) > 0 {
		return true
	}
	if checker.IsTupleType(t) || checker.Checker_isArrayType(c, t) || !isAnonymousObjectSymbol(typeSymbol(t)) {
		return false
	}
	seen[t] = true
	for _, property := range propertiesOfType(c, c.GetApparentType(t)) {
		if isAccessorSymbol(property) || !cloneSafe(c, typeOfSymbol(c, property), seen) {
			return false
		}
	}
	return true
}
