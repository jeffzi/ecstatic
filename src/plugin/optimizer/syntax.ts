import {
  type BinaryOperator,
  type BindingName,
  type Expression,
  type Node,
  type ParameterDeclaration,
  SyntaxKind,
} from "typescript/ast";
import {
  isAsExpression,
  isClassLikeDeclaration,
  isExpressionWithTypeArguments,
  isHeritageClause,
  isIdentifier,
  isInterfaceDeclaration,
  isNonNullExpression,
  isParenthesizedExpression,
  isSatisfiesExpression,
  isTypeAliasDeclaration,
  isTypeAssertion,
  isTypeNode,
} from "typescript/ast/is";

const ARITHMETIC_OPERATORS: ReadonlyMap<SyntaxKind, BinaryOperator> = new Map([
  [SyntaxKind.PlusEqualsToken, SyntaxKind.PlusToken],
  [SyntaxKind.MinusEqualsToken, SyntaxKind.MinusToken],
  [SyntaxKind.AsteriskEqualsToken, SyntaxKind.AsteriskToken],
  [SyntaxKind.AsteriskAsteriskEqualsToken, SyntaxKind.AsteriskAsteriskToken],
  [SyntaxKind.SlashEqualsToken, SyntaxKind.SlashToken],
  [SyntaxKind.PercentEqualsToken, SyntaxKind.PercentToken],
  [SyntaxKind.LessThanLessThanEqualsToken, SyntaxKind.LessThanLessThanToken],
  [SyntaxKind.GreaterThanGreaterThanEqualsToken, SyntaxKind.GreaterThanGreaterThanToken],
  [
    SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken,
    SyntaxKind.GreaterThanGreaterThanGreaterThanToken,
  ],
  [SyntaxKind.AmpersandEqualsToken, SyntaxKind.AmpersandToken],
  [SyntaxKind.BarEqualsToken, SyntaxKind.BarToken],
  [SyntaxKind.CaretEqualsToken, SyntaxKind.CaretToken],
]);

const LOGICAL_OPERATORS: ReadonlyMap<SyntaxKind, BinaryOperator> = new Map([
  [SyntaxKind.BarBarEqualsToken, SyntaxKind.BarBarToken],
  [SyntaxKind.AmpersandAmpersandEqualsToken, SyntaxKind.AmpersandAmpersandToken],
  [SyntaxKind.QuestionQuestionEqualsToken, SyntaxKind.QuestionQuestionToken],
]);

/**
 * Strips the parentheses and non-null assertions around an expression, which change nothing at
 * runtime.
 *
 * @param node - The wrapped expression.
 * @returns The expression inside every such wrapper, or `node` when it has none.
 */
export function skipWrappers(node: Expression): Expression {
  let inner = node;
  while (isParenthesizedExpression(inner) || isNonNullExpression(inner)) inner = inner.expression;
  return inner;
}

/**
 * Strips every wrapper that compiles to its operand: parentheses, non-null assertions, and the
 * `as`, `satisfies`, and angle-bracket type assertions.
 *
 * @param node - The wrapped expression.
 * @returns The expression inside every such wrapper, or `node` when it has none.
 */
export function skipErased(node: Expression): Expression {
  let inner = node;
  while (
    isParenthesizedExpression(inner) ||
    isNonNullExpression(inner) ||
    isAsExpression(inner) ||
    isSatisfiesExpression(inner) ||
    isTypeAssertion(inner)
  ) {
    inner = inner.expression;
  }
  return inner;
}

/**
 * The outermost of the parentheses around a node.
 *
 * @param node - The node inside the parentheses.
 * @returns The outermost parenthesized expression, or `node` itself when there are none.
 */
export function outermostParens(node: Node): Node {
  let outer = node;
  while (isParenthesizedExpression(outer.parent)) outer = outer.parent;
  return outer;
}

/**
 * The names a binding declares, at any depth of its patterns. An array pattern's elision declares
 * nothing.
 *
 * @param name - A declaration's binding name.
 * @returns The declared names in source order.
 */
export function boundNames(name: BindingName): string[] {
  if (isIdentifier(name)) return [name.text];
  return name.elements.flatMap((element) =>
    element.name === undefined ? [] : boundNames(element.name),
  );
}

/**
 * The binary operator an arithmetic compound assignment applies.
 *
 * @param compound - An assignment operator's kind.
 * @returns The operator `compound` applies, or undefined for `=` and the logical assignments.
 */
export function arithmeticOperator(compound: SyntaxKind): BinaryOperator | undefined {
  return ARITHMETIC_OPERATORS.get(compound);
}

/**
 * The short-circuiting operator that guards the store of a logical assignment.
 *
 * @param logical - An assignment operator's kind.
 * @returns The operator guarding the store, or undefined for `=` and the arithmetic assignments.
 */
export function logicalOperator(logical: SyntaxKind): BinaryOperator | undefined {
  return LOGICAL_OPERATORS.get(logical);
}

/**
 * Whether a node is erased at compile time, so nothing inside it ever runs: a type, or an interface
 * or type alias declaration. A class's `extends` expression is a value, not a type.
 *
 * @param node - The node to test.
 * @returns Whether `node` is type-only.
 */
export function isTypeOnly(node: Node): boolean {
  if (isExpressionWithTypeArguments(node)) return !isClassExtends(node);
  return isTypeNode(node) || isInterfaceDeclaration(node) || isTypeAliasDeclaration(node);
}

function isClassExtends(node: Node): boolean {
  const clause = node.parent;
  return (
    isHeritageClause(clause) &&
    clause.token === SyntaxKind.ExtendsKeyword &&
    isClassLikeDeclaration(clause.parent)
  );
}

/**
 * Whether a parameter is a `this` parameter, which types the function's `this` and is erased.
 *
 * @param param - The parameter to test.
 * @returns Whether `param` is named `this`.
 */
export function isThisParameter(param: ParameterDeclaration): boolean {
  return isIdentifier(param.name) && param.name.text === "this";
}
