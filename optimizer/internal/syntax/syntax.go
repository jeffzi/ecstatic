// Package syntax answers questions about TypeScript syntax trees that need no checker: the wrappers around an
// expression, the names a binding declares, and the operators a compound assignment applies. Analysis and emit both
// rely on these answers, so they must agree.
package syntax

import "github.com/microsoft/typescript-go/shim/ast"

// SkipWrappers returns node without the parentheses and non-null assertions around it, which change nothing at
// runtime.
func SkipWrappers(node *ast.Node) *ast.Node {
	for node.Kind == ast.KindParenthesizedExpression || node.Kind == ast.KindNonNullExpression {
		node = node.Expression()
	}
	return node
}

// OutermostParens returns the outermost of the parentheses around node, node itself when there is none.
func OutermostParens(node *ast.Node) *ast.Node {
	for node.Parent.Kind == ast.KindParenthesizedExpression {
		node = node.Parent
	}
	return node
}

// ForEachBoundName calls visit with each name that name, a binding name, declares, at any depth of its patterns. An
// array pattern's elision is a binding element without a name, and declares nothing.
func ForEachBoundName(name *ast.Node, visit func(string)) {
	if name.Kind == ast.KindIdentifier {
		visit(name.Text())
		return
	}
	for _, element := range name.AsBindingPattern().Elements.Nodes {
		if inner := element.Name(); inner != nil {
			ForEachBoundName(inner, visit)
		}
	}
}

// ArithmeticOperator returns the binary operator that compound, an arithmetic compound assignment operator, applies,
// and false for any other operator. Every assignment operator is `=`, an arithmetic one, or a logical one that
// LogicalOperator maps.
func ArithmeticOperator(compound ast.Kind) (ast.Kind, bool) {
	switch compound {
	case ast.KindPlusEqualsToken:
		return ast.KindPlusToken, true
	case ast.KindMinusEqualsToken:
		return ast.KindMinusToken, true
	case ast.KindAsteriskEqualsToken:
		return ast.KindAsteriskToken, true
	case ast.KindAsteriskAsteriskEqualsToken:
		return ast.KindAsteriskAsteriskToken, true
	case ast.KindSlashEqualsToken:
		return ast.KindSlashToken, true
	case ast.KindPercentEqualsToken:
		return ast.KindPercentToken, true
	case ast.KindLessThanLessThanEqualsToken:
		return ast.KindLessThanLessThanToken, true
	case ast.KindGreaterThanGreaterThanEqualsToken:
		return ast.KindGreaterThanGreaterThanToken, true
	case ast.KindGreaterThanGreaterThanGreaterThanEqualsToken:
		return ast.KindGreaterThanGreaterThanGreaterThanToken, true
	case ast.KindAmpersandEqualsToken:
		return ast.KindAmpersandToken, true
	case ast.KindBarEqualsToken:
		return ast.KindBarToken, true
	case ast.KindCaretEqualsToken:
		return ast.KindCaretToken, true
	default:
		return 0, false
	}
}

// LogicalOperator returns the short-circuiting operator that guards the store of logical, a logical assignment
// operator, and false for any other operator.
func LogicalOperator(logical ast.Kind) (ast.Kind, bool) {
	switch logical {
	case ast.KindBarBarEqualsToken:
		return ast.KindBarBarToken, true
	case ast.KindAmpersandAmpersandEqualsToken:
		return ast.KindAmpersandAmpersandToken, true
	case ast.KindQuestionQuestionEqualsToken:
		return ast.KindQuestionQuestionToken, true
	default:
		return 0, false
	}
}
