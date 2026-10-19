package emit

import (
	"slices"

	"github.com/microsoft/typescript-go/shim/ast"
	"github.com/microsoft/typescript-go/shim/printer"

	"github.com/jeffzi/ecstatic/optimizer/internal/nodes"
	"github.com/jeffzi/ecstatic/optimizer/internal/plan"
	"github.com/jeffzi/ecstatic/optimizer/internal/syntax"
)

// transplant rewrites the statements of a callback body that behave differently once the body runs as the row
// loop's body instead of as the callback eachStorageMatched (src/entity/each.ts) calls once per row: its own
// return statements, its own var declarations, and its own labels that a statement enclosing the call also declares.
type transplant struct {
	ctx *printer.EmitContext
	// returns maps each return statement of the callback to whether an iteration statement or a switch lies between
	// it and the body root, where a bare continue would not reach the row loop.
	returns map[*ast.Node]bool
	// varLists holds the declaration list of every var statement and for head of the callback.
	varLists map[*ast.Node]bool
	// label is the row loop's label; nil when no return needs one.
	label *ast.Node
	// applied is the loop's own set, so rules the transplant records show up in the loop's Applied.
	applied ruleSet
	// relabeled maps each labeled statement, break, and continue of the callback's own code whose label a statement
	// enclosing the call also declares, in the same function, to the fresh label it takes: once inlined, the two
	// would be duplicate labels of one function.
	relabeled map[*ast.Node]*ast.Node
	// names are the names the var declarations bind, in the order they are first declared.
	names []string
}

// newTransplant returns the transplant of inlining's callback, whose node IDs table maps, recording the rules it
// applies in applied.
func newTransplant(ctx *printer.EmitContext, table *nodes.Table, inlining plan.EachInlining, applied ruleSet) *transplant {
	t := &transplant{
		ctx: ctx, returns: map[*ast.Node]bool{}, varLists: map[*ast.Node]bool{}, applied: applied, relabeled: map[*ast.Node]*ast.Node{},
	}
	call := tableNode(table, inlining.Call, "call")
	if enclosing := enclosingLabels(call); len(enclosing) > 0 {
		args := call.Arguments()
		t.relabel(args[len(args)-1].Body(), enclosing, map[string]*ast.Node{})
	}
	if len(inlining.VarToLet) > 0 {
		applied.add(ruleVarToLet)
	}
	for _, r := range inlining.Continues {
		t.returns[tableNode(table, r.Node, "return")] = r.Nested
		if r.Nested && t.label == nil {
			t.label = ctx.Factory.NewUniqueNameEx("row", optimistic())
		}
	}
	for _, id := range inlining.VarToLet {
		decl := tableNode(table, id, "var declaration")
		t.varLists[decl.Parent] = true
		syntax.ForEachBoundName(decl.Name(), func(name string) {
			if !slices.Contains(t.names, name) {
				t.names = append(t.names, name)
			}
		})
	}
	return t
}

// enclosingLabels lists the labels of the statements enclosing call, up to the function, class static block, or file
// that holds it.
func enclosingLabels(call *ast.Node) []string {
	var labels []string
	for node := call.Parent; node != nil && !isLabelScope(node); node = node.Parent {
		if node.Kind == ast.KindLabeledStatement {
			labels = append(labels, node.Label().Text())
		}
	}
	return labels
}

// isLabelScope reports whether node holds labels of its own, which neither reach nor clash with the labels around
// it: a function or a class static block.
func isLabelScope(node *ast.Node) bool {
	return ast.IsFunctionLike(node) || node.Kind == ast.KindClassStaticBlockDeclaration
}

// relabel gives every labeled statement, break, and continue in node, the callback's own code, whose label is one of
// enclosing a fresh label, the same one for every use of a name, which fresh records. A function or class static
// block in node keeps its labels.
func (t *transplant) relabel(node *ast.Node, enclosing []string, fresh map[string]*ast.Node) {
	if isLabelScope(node) {
		return
	}
	if label := statementLabel(node); label != nil && slices.Contains(enclosing, label.Text()) {
		if fresh[label.Text()] == nil {
			fresh[label.Text()] = t.ctx.Factory.NewUniqueNameEx(label.Text(), optimistic())
		}
		t.relabeled[node] = fresh[label.Text()]
	}
	node.ForEachChild(func(child *ast.Node) bool {
		t.relabel(child, enclosing, fresh)
		return false
	})
}

// statementLabel is the label that node, a labeled statement, break, or continue, declares or targets; nil for any
// other node and for a break or continue without a label.
func statementLabel(node *ast.Node) *ast.Node {
	if isLabelStatement(node) {
		return node.Label()
	}
	return nil
}

// isLabelStatement reports whether node is a labeled statement, a break, or a continue: a statement that declares or
// may target a label.
func isLabelStatement(node *ast.Node) bool {
	switch node.Kind {
	case ast.KindLabeledStatement, ast.KindBreakStatement, ast.KindContinueStatement:
		return true
	default:
		return false
	}
}

// visit returns the rewrite of node and true when node is a return statement, a var declaration list, or a
// relabeled statement of the callback, visiting the parts it keeps with visitor. A nil rewrite drops node.
//
// A return becomes `continue`, labeled with the row loop's label when it stands under an inner loop or switch;
// `return expr` first runs expr as a statement, which the printer parenthesizes when expr would otherwise read as a
// block or a function declaration. A var statement becomes the assignments of its initializers, and a for head's
// var list its assignments or, in a for…in or for…of head, its one assignment target. A relabeled statement, break,
// or continue takes its fresh label.
func (t *transplant) visit(visitor *ast.NodeVisitor, node *ast.Node) (*ast.Node, bool) {
	factory := t.ctx.Factory
	if label, ok := t.relabeled[node]; ok {
		return t.withLabel(visitor, node, label), true
	}
	if nested, ok := t.returns[node]; ok {
		t.noteReturn(node, nested)
		var label *ast.Node
		if nested {
			label = t.label
		}
		next := factory.NewContinueStatement(label)
		if expression := node.Expression(); expression != nil {
			return factory.NewSyntaxList([]*ast.Node{factory.NewExpressionStatement(visitor.VisitNode(expression)), next}), true
		}
		return next, true
	}
	if node.Kind == ast.KindReturnStatement {
		t.applied.add(ruleReturnInNestedFunction)
		return nil, false
	}
	if node.Kind == ast.KindVariableStatement && t.varLists[node.AsVariableStatement().DeclarationList] {
		assignments := t.assignments(visitor, node.AsVariableStatement().DeclarationList)
		if assignments == nil {
			return nil, true
		}
		return factory.NewExpressionStatement(assignments), true
	}
	if !t.varLists[node] {
		return nil, false
	}
	if kind := node.Parent.Kind; kind == ast.KindForInStatement || kind == ast.KindForOfStatement {
		return t.target(visitor, node.AsVariableDeclarationList().Declarations.Nodes[0].Name()), true
	}
	return t.assignments(visitor, node), true
}

// withLabel is node, a labeled statement, break, or continue, under label, with a labeled statement's body visited
// with visitor.
func (t *transplant) withLabel(visitor *ast.NodeVisitor, node, label *ast.Node) *ast.Node {
	t.applied.add(ruleUserLabelRenamed)
	factory := t.ctx.Factory
	switch node.Kind {
	case ast.KindLabeledStatement:
		return factory.NewLabeledStatement(label, visitor.VisitNode(node.AsLabeledStatement().Statement))
	case ast.KindBreakStatement:
		return factory.NewBreakStatement(label)
	default:
		return factory.NewContinueStatement(label)
	}
}

// noteReturn records the rules of node, a return of the callback that nested says stands under an inner loop or
// switch: a return without a value, or with one that starts with an object literal, a function expression, or
// anything else, the labeled continue, and a return inside `try … finally`.
func (t *transplant) noteReturn(node *ast.Node, nested bool) {
	switch expression := node.Expression(); {
	case expression == nil:
		t.applied.add(ruleReturnVoid)
	case leftmostExpression(expression).Kind == ast.KindObjectLiteralExpression:
		t.applied.add(ruleReturnObjectLiteral)
	case leftmostExpression(expression).Kind == ast.KindFunctionExpression:
		t.applied.add(ruleReturnFunctionExpression)
	default:
		t.applied.add(ruleReturnValue)
	}
	if nested {
		t.applied.add(ruleReturnLabeled)
	}
	for parent := node.Parent; parent != nil && !ast.IsFunctionLike(parent); parent = parent.Parent {
		if parent.Kind == ast.KindTryStatement && parent.AsTryStatement().FinallyBlock != nil {
			t.applied.add(ruleReturnInFinally)
			return
		}
	}
}

// leftmostExpression is the expression that expression's text starts with, the one the printer tests when it decides
// whether an expression statement would read as a block or a function declaration.
func leftmostExpression(expression *ast.Node) *ast.Node {
	for {
		switch expression.Kind {
		case ast.KindPostfixUnaryExpression:
			expression = expression.AsPostfixUnaryExpression().Operand
		case ast.KindBinaryExpression:
			expression = expression.AsBinaryExpression().Left
		case ast.KindConditionalExpression:
			expression = expression.AsConditionalExpression().Condition
		case ast.KindTaggedTemplateExpression:
			expression = expression.AsTaggedTemplateExpression().Tag
		case ast.KindCallExpression, ast.KindAsExpression, ast.KindElementAccessExpression, ast.KindPropertyAccessExpression,
			ast.KindNonNullExpression, ast.KindPartiallyEmittedExpression, ast.KindSatisfiesExpression:
			expression = expression.Expression()
		default:
			return expression
		}
	}
}

// assignments is the comma list assigning each declaration of list that has an initializer, nil when none has.
func (t *transplant) assignments(visitor *ast.NodeVisitor, list *ast.Node) *ast.Node {
	var assigned []*ast.Node
	for _, decl := range list.AsVariableDeclarationList().Declarations.Nodes {
		if initializer := decl.Initializer(); initializer != nil {
			assigned = append(assigned, assignTo(t.ctx, t.target(visitor, decl.Name()), visitor.VisitNode(initializer)))
		}
	}
	if len(assigned) == 0 {
		return nil
	}
	return t.ctx.Factory.InlineExpressions(assigned)
}

// target is name, the binding name of a var declaration, as the assignment target that binds the same names in the
// same order: a binding pattern becomes the object or array literal of the same shape, whose defaults and computed
// keys are visited with visitor.
func (t *transplant) target(visitor *ast.NodeVisitor, name *ast.Node) *ast.Node {
	factory := t.ctx.Factory
	switch name.Kind {
	case ast.KindObjectBindingPattern:
		elements := name.AsBindingPattern().Elements.Nodes
		properties := make([]*ast.Node, 0, len(elements))
		for _, element := range elements {
			properties = append(properties, t.objectTarget(visitor, element))
		}
		return factory.NewObjectLiteralExpression(factory.NewNodeList(properties), false)
	case ast.KindArrayBindingPattern:
		elements := name.AsBindingPattern().Elements.Nodes
		targets := make([]*ast.Node, 0, len(elements))
		for _, element := range elements {
			targets = append(targets, t.arrayTarget(visitor, element))
		}
		return factory.NewArrayLiteralExpression(factory.NewNodeList(targets), false)
	}
	return name
}

// objectTarget is element, a binding element of an object pattern, as the member of an object assignment pattern.
func (t *transplant) objectTarget(visitor *ast.NodeVisitor, element *ast.Node) *ast.Node {
	factory := t.ctx.Factory
	if element.AsBindingElement().DotDotDotToken != nil {
		return factory.NewSpreadAssignment(t.target(visitor, element.Name()))
	}
	fallback := visitor.VisitNode(element.Initializer())
	if key := element.PropertyName(); key != nil {
		return factory.NewPropertyAssignment(nil, visitor.VisitNode(key), nil, nil, t.withDefault(t.target(visitor, element.Name()), fallback))
	}
	var equals *ast.Node
	if fallback != nil {
		equals = factory.NewToken(ast.KindEqualsToken)
	}
	return factory.NewShorthandPropertyAssignment(nil, element.Name(), nil, nil, equals, fallback)
}

// arrayTarget is element, a binding element of an array pattern, as the element of an array assignment pattern; an
// elision stays an elision.
func (t *transplant) arrayTarget(visitor *ast.NodeVisitor, element *ast.Node) *ast.Node {
	factory := t.ctx.Factory
	if element.Name() == nil {
		return factory.NewOmittedExpression()
	}
	if element.AsBindingElement().DotDotDotToken != nil {
		return factory.NewSpreadElement(t.target(visitor, element.Name()))
	}
	return t.withDefault(t.target(visitor, element.Name()), visitor.VisitNode(element.Initializer()))
}

// withDefault is `target = fallback`, or target alone when fallback is nil.
func (t *transplant) withDefault(target, fallback *ast.Node) *ast.Node {
	if fallback == nil {
		return target
	}
	return assignTo(t.ctx, target, fallback)
}

// bindings is the `let` statement declaring, once per row, every name the var declarations bind but a function
// declaration at the root of body, the callback's body, does not; nil when no name is left. In the callback, such a
// var and function are one binding, which the function declaration alone still declares in the row's block, where a
// `let` of the same name would not compile.
func (t *transplant) bindings(body *ast.Node) *ast.Node {
	var functions []string
	if body.Kind == ast.KindBlock {
		for _, statement := range body.Statements() {
			if statement.Kind == ast.KindFunctionDeclaration && statement.Name() != nil {
				functions = append(functions, statement.Name().Text())
			}
		}
	}
	factory := t.ctx.Factory
	var declarations []*ast.Node
	for _, name := range t.names {
		if !slices.Contains(functions, name) {
			declarations = append(declarations, declaration(t.ctx, factory.NewIdentifier(name), nil))
		}
	}
	if len(declarations) == 0 {
		return nil
	}
	return letStatement(t.ctx, declarations...)
}

// labeled is loop under the row loop's label, or loop itself when no return needs the label.
func (t *transplant) labeled(loop *ast.Node) *ast.Node {
	if t.label == nil {
		return loop
	}
	return t.ctx.Factory.NewLabeledStatement(t.label, loop)
}
