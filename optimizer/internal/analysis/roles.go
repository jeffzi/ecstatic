package analysis

import (
	"github.com/microsoft/typescript-go/shim/ast"

	"github.com/jeffzi/ecstatic/optimizer/internal/syntax"
)

// outermostWrapper returns the outermost of the parentheses and non-null
// assertions around node, node itself when there is none.
func outermostWrapper(node *ast.Node) *ast.Node {
	for node.Parent.Kind == ast.KindParenthesizedExpression || node.Parent.Kind == ast.KindNonNullExpression {
		node = node.Parent
	}
	return node
}

// isErasedWrapper reports whether an expression of kind wraps an operand and
// compiles to it, or to it in parentheses.
func isErasedWrapper(kind ast.Kind) bool {
	switch kind {
	case ast.KindParenthesizedExpression, ast.KindNonNullExpression, ast.KindAsExpression, ast.KindSatisfiesExpression,
		ast.KindTypeAssertionExpression:
		return true
	default:
		return false
	}
}

// skipErased returns node without the wrappers around it that
// isErasedWrapper names.
func skipErased(node *ast.Node) *ast.Node {
	for isErasedWrapper(node.Kind) {
		node = node.Expression()
	}
	return node
}

// outermostErased returns the outermost of the wrappers around node that
// isErasedWrapper names, node itself when there is none.
func outermostErased(node *ast.Node) *ast.Node {
	for isErasedWrapper(node.Parent.Kind) {
		node = node.Parent
	}
	return node
}

// isTestPosition reports whether the value of expr reaches only a condition:
// of an if, while, do, or for statement or a conditional expression, the
// operand of `!`, or an operand of `&&` or `||` whose own value does.
func isTestPosition(expr *ast.Node) bool {
	node := syntax.OutermostParens(expr)
	switch parent := node.Parent; parent.Kind {
	case ast.KindIfStatement, ast.KindWhileStatement, ast.KindDoStatement:
		return parent.Expression() == node
	case ast.KindForStatement:
		return parent.AsForStatement().Condition == node
	case ast.KindConditionalExpression:
		return parent.AsConditionalExpression().Condition == node
	case ast.KindPrefixUnaryExpression:
		return parent.AsPrefixUnaryExpression().Operator == ast.KindExclamationToken
	case ast.KindBinaryExpression:
		operator := parent.AsBinaryExpression().OperatorToken.Kind
		return (operator == ast.KindAmpersandAmpersandToken || operator == ast.KindBarBarToken) && isTestPosition(parent)
	default:
		return false
	}
}

// isWriteTarget reports whether expr is written: the target of an
// assignment, an update, a destructuring assignment, or a for…in or for…of
// head.
func isWriteTarget(expr *ast.Node) bool {
	node := syntax.OutermostParens(expr)
	up := node.Parent
	return isPatternTarget(node) || isUpdateOf(up, node) ||
		(up.Kind == ast.KindBinaryExpression && isAssignment(up.AsBinaryExpression().OperatorToken.Kind) && up.AsBinaryExpression().Left == node)
}

// isPatternTarget reports whether expr is a target inside a destructuring
// assignment, defaults included, or the head of a for…in or for…of
// statement.
func isPatternTarget(expr *ast.Node) bool {
	for node := expr; ; node = node.Parent {
		switch parent := node.Parent; parent.Kind {
		case ast.KindParenthesizedExpression, ast.KindArrayLiteralExpression, ast.KindObjectLiteralExpression,
			ast.KindSpreadElement, ast.KindSpreadAssignment:
		case ast.KindPropertyAssignment:
			if parent.Initializer() != node {
				return false
			}
		case ast.KindBinaryExpression:
			binary := parent.AsBinaryExpression()
			if binary.OperatorToken.Kind != ast.KindEqualsToken || binary.Left != node {
				return false
			}
			if isLiteralPattern(node) {
				return true
			}
		case ast.KindForInStatement, ast.KindForOfStatement:
			return parent.Initializer() == node
		default:
			return false
		}
	}
}

// isDestructured reports whether expr is the value an object or array
// pattern destructures, in a declaration or an assignment.
func isDestructured(expr *ast.Node) bool {
	switch parent := expr.Parent; parent.Kind {
	case ast.KindVariableDeclaration:
		return parent.Initializer() == expr && ast.IsBindingPattern(parent.Name())
	case ast.KindBinaryExpression:
		return isDestructuringAssignment(parent) && parent.AsBinaryExpression().Right == expr
	default:
		return false
	}
}

// isDestructuringAssignment reports whether node is an `=` whose target is an
// array or object literal, a pattern the value is destructured into.
func isDestructuringAssignment(node *ast.Node) bool {
	return isBinary(node, ast.KindEqualsToken) && isLiteralPattern(node.AsBinaryExpression().Left)
}

// isLiteralPattern reports whether node is an array or object literal, the
// forms an assignment pattern takes.
func isLiteralPattern(node *ast.Node) bool {
	return node.Kind == ast.KindArrayLiteralExpression || node.Kind == ast.KindObjectLiteralExpression
}

func isBinary(node *ast.Node, operator ast.Kind) bool {
	return node.Kind == ast.KindBinaryExpression && node.AsBinaryExpression().OperatorToken.Kind == operator
}

// isUpdateOf reports whether node is a prefix or postfix `++` or `--` of
// operand.
func isUpdateOf(node, operand *ast.Node) bool {
	switch node.Kind {
	case ast.KindPrefixUnaryExpression:
		prefix := node.AsPrefixUnaryExpression()
		return isUpdate(prefix.Operator) && prefix.Operand == operand
	case ast.KindPostfixUnaryExpression:
		return node.AsPostfixUnaryExpression().Operand == operand
	default:
		return false
	}
}

func isAssignment(operator ast.Kind) bool {
	return operator >= ast.KindFirstAssignment && operator <= ast.KindLastAssignment
}

func isUpdate(operator ast.Kind) bool {
	return operator == ast.KindPlusPlusToken || operator == ast.KindMinusMinusToken
}

// patternKey returns the key element, a property of an object pattern, reads,
// and false when the key is computed.
func patternKey(element *ast.Node) (string, bool) {
	key := element.AsBindingElement().PropertyName
	if key == nil {
		key = element.Name()
	}
	switch key.Kind {
	case ast.KindIdentifier, ast.KindStringLiteral, ast.KindNumericLiteral, ast.KindBigIntLiteral:
		return key.Text(), true
	default:
		return "", false
	}
}

// literalElementKey returns the key that access, an element access, names
// with a string literal or a template literal without substitutions, and
// false for any other key.
func literalElementKey(access *ast.Node) (string, bool) {
	key := access.AsElementAccessExpression().ArgumentExpression
	if key.Kind != ast.KindStringLiteral && key.Kind != ast.KindNoSubstitutionTemplateLiteral {
		return "", false
	}
	return key.Text(), true
}
