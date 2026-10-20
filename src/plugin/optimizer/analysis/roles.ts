import {
  type BinaryExpression,
  type BindingElement,
  type ElementAccessExpression,
  type Identifier,
  type Node,
  NodeFlags,
  type ObjectBindingPattern,
  SyntaxKind,
} from "typescript/ast";
import {
  isArrayLiteralExpression,
  isAsExpression,
  isAssignmentOperator,
  isBinaryExpression,
  isBindingElement,
  isBindingPattern,
  isCallExpression,
  isConditionalExpression,
  isDoStatement,
  isForInStatement,
  isForOfStatement,
  isForStatement,
  isIdentifier,
  isIfStatement,
  isNonNullExpression,
  isNoSubstitutionTemplateLiteral,
  isObjectBindingPattern,
  isObjectLiteralExpression,
  isParenthesizedExpression,
  isPostfixUnaryExpression,
  isPrefixUnaryExpression,
  isPropertyAccessExpression,
  isPropertyAssignment,
  isSatisfiesExpression,
  isShorthandPropertyAssignment,
  isSpreadAssignment,
  isSpreadElement,
  isStringLiteral,
  isTaggedTemplateExpression,
  isTypeAssertion,
  isVariableDeclaration,
  isVariableDeclarationList,
  isWhileStatement,
} from "typescript/ast/is";

import { type Checker, type CheckerSymbol, resolveSymbol } from "../compiler.js";
import { outermostParens } from "../syntax.js";

/**
 * Whether a node is an `=` whose target is an array or object literal, a pattern the value is
 * destructured into.
 *
 * @param node - The node to test.
 * @returns Whether `node` is a destructuring assignment.
 */
export function isDestructuringAssignment(node: Node): node is BinaryExpression {
  return isBinary(node, SyntaxKind.EqualsToken) && isLiteralPattern(node.left);
}

/**
 * Whether a node is a binary expression applying an operator.
 *
 * @param node - The node to test.
 * @param operator - The operator's token kind.
 * @returns Whether `node` applies `operator`.
 */
export function isBinary(node: Node, operator: SyntaxKind): node is BinaryExpression {
  return isBinaryExpression(node) && node.operatorToken.kind === operator;
}

/**
 * Whether a node is an array or object literal, the forms an assignment pattern takes.
 *
 * @param node - The node to test.
 * @returns Whether `node` is a literal pattern.
 */
function isLiteralPattern(node: Node): boolean {
  return isArrayLiteralExpression(node) || isObjectLiteralExpression(node);
}

/**
 * The outermost of the parentheses and non-null assertions around a node.
 *
 * @param node - The wrapped node.
 * @returns The outermost wrapper, or `node` itself when there is none.
 */
export function outermostWrapper(node: Node): Node {
  let outer = node;
  while (isParenthesizedExpression(outer.parent) || isNonNullExpression(outer.parent)) {
    outer = outer.parent;
  }
  return outer;
}

/**
 * The outermost of the wrappers around a node that compile to their operand: parentheses,
 * non-null assertions, and the `as`, `satisfies`, and angle-bracket type assertions.
 *
 * @param node - The wrapped node.
 * @returns The outermost wrapper, or `node` itself when there is none.
 */
function outermostErased(node: Node): Node {
  let outer = node;
  while (isErasedWrapper(outer.parent)) outer = outer.parent;
  return outer;
}

function isErasedWrapper(node: Node): boolean {
  return (
    isParenthesizedExpression(node) ||
    isNonNullExpression(node) ||
    isAsExpression(node) ||
    isSatisfiesExpression(node) ||
    isTypeAssertion(node)
  );
}

/**
 * Whether an expression is the callee of a call or a tagged template, through the parentheses and
 * type wrappers the compiler erases. None of them detach the callee from its receiver, so the call
 * runs with the receiver of `expr` as `this`.
 *
 * @param expr - The expression to test.
 * @returns Whether `expr` is called.
 */
export function isCallee(expr: Node): boolean {
  const outer = outermostErased(expr);
  const up = outer.parent;
  return (
    (isCallExpression(up) && up.expression === outer) ||
    (isTaggedTemplateExpression(up) && up.tag === outer)
  );
}

/**
 * Whether the value of an expression reaches only a condition: of an `if`, `while`, `do`, or `for`
 * statement or a conditional expression, the operand of `!`, or an operand of `&&` or `||` whose
 * own value does.
 *
 * @param expr - The expression to test.
 * @returns Whether `expr` stands in a test position.
 */
export function isTestPosition(expr: Node): boolean {
  const node = outermostParens(expr);
  const parent = node.parent;
  if (isIfStatement(parent) || isWhileStatement(parent) || isDoStatement(parent)) {
    return parent.expression === node;
  }
  if (isForStatement(parent)) return parent.condition === node;
  if (isConditionalExpression(parent)) return parent.condition === node;
  if (isPrefixUnaryExpression(parent)) return parent.operator === SyntaxKind.ExclamationToken;
  return (
    (isBinary(parent, SyntaxKind.AmpersandAmpersandToken) ||
      isBinary(parent, SyntaxKind.BarBarToken)) &&
    isTestPosition(parent)
  );
}

/**
 * Whether an expression is written: the target of an assignment, an update, a destructuring
 * assignment, or a `for…in` or `for…of` head.
 *
 * @param expr - The expression to test.
 * @returns Whether `expr` is a write target.
 */
export function isWriteTarget(expr: Node): boolean {
  const node = outermostParens(expr);
  const up = node.parent;
  return isPatternTarget(node) || isUpdateOf(up, node) || isAssignmentTo(up, node);
}

/**
 * Whether a node assigns an operand with `=`, a compound operator, or a logical assignment.
 *
 * @param node - The node to test.
 * @param operand - The assigned target.
 * @returns Whether `node` assigns `operand`.
 */
export function isAssignmentTo(node: Node, operand: Node): node is BinaryExpression {
  return (
    isBinaryExpression(node) &&
    isAssignmentOperator(node.operatorToken.kind) &&
    node.left === operand
  );
}

/**
 * Whether an expression is a target inside a destructuring assignment, defaults included, or the
 * head of a `for…in` or `for…of` statement.
 *
 * @param expr - The expression to test.
 * @returns Whether `expr` is written by a pattern.
 */
export function isPatternTarget(expr: Node): boolean {
  for (let node = expr; ; node = node.parent) {
    const verdict = patternVerdict(node);
    if (verdict !== undefined) return verdict;
  }
}

/**
 * What a node's parent says about whether the node is a pattern target.
 *
 * @param node - The node climbing toward the pattern's root.
 * @returns The answer, or undefined when it depends on the levels above the parent.
 */
function patternVerdict(node: Node): boolean | undefined {
  const parent = node.parent;
  if (isPropertyAssignment(parent)) return parent.initializer === node ? undefined : false;
  if (isBinaryExpression(parent)) return assignmentVerdict(parent, node);
  if (isForInStatement(parent) || isForOfStatement(parent)) return parent.initializer === node;
  return isPatternPart(parent) ? undefined : false;
}

/**
 * What an assignment says about whether its target is a pattern target.
 *
 * @param assignment - The binary expression holding `node`.
 * @param node - The node climbing toward the pattern's root.
 * @returns `true` for an array or object literal on the left of `=`, `false` when `node` is not the
 *   left of an `=`, or undefined when the levels above decide.
 */
function assignmentVerdict(assignment: BinaryExpression, node: Node): boolean | undefined {
  if (!isBinary(assignment, SyntaxKind.EqualsToken) || assignment.left !== node) return false;
  return isLiteralPattern(node) ? true : undefined;
}

function isPatternPart(node: Node): boolean {
  return (
    isParenthesizedExpression(node) ||
    isLiteralPattern(node) ||
    isSpreadElement(node) ||
    isSpreadAssignment(node)
  );
}

/**
 * Whether an expression is the value an object or array pattern destructures, in a declaration or
 * an assignment.
 *
 * @param expr - The expression to test.
 * @returns Whether `expr` is destructured.
 */
export function isDestructured(expr: Node): boolean {
  const parent = expr.parent;
  if (isVariableDeclaration(parent)) {
    return parent.initializer === expr && isBindingPattern(parent.name);
  }
  return isDestructuringAssignment(parent) && parent.right === expr;
}

/**
 * Whether a node is a prefix or postfix `++` or `--` of an operand.
 *
 * @param node - The node to test.
 * @param operand - The updated operand.
 * @returns Whether `node` updates `operand`.
 */
export function isUpdateOf(node: Node, operand: Node): boolean {
  if (isPrefixUnaryExpression(node)) {
    return (
      (node.operator === SyntaxKind.PlusPlusToken ||
        node.operator === SyntaxKind.MinusMinusToken) &&
      node.operand === operand
    );
  }
  return isPostfixUnaryExpression(node) && node.operand === operand;
}

/**
 * Whether an identifier names a property or declares a binding rather than reading one. A
 * shorthand property both declares a property and reads a binding, so it reads.
 *
 * @param id - The identifier to test.
 * @returns Whether `id` stands in a name position.
 */
export function isNamePosition(id: Identifier): boolean {
  const parent = id.parent;
  if (isPropertyAccessExpression(parent)) return parent.name === id;
  if (isShorthandPropertyAssignment(parent)) return false;
  if (isBindingElement(parent)) return parent.name === id || parent.propertyName === id;
  return "name" in parent && parent.name === id;
}

/**
 * The key a property of an object binding pattern reads.
 *
 * @param element - An element of an object binding pattern.
 * @returns The key's text, or undefined when the key is computed.
 */
export function patternKey(element: BindingElement): string | undefined {
  const key = element.propertyName ?? element.name;
  switch (key?.kind) {
    case SyntaxKind.Identifier:
    case SyntaxKind.StringLiteral:
    case SyntaxKind.NumericLiteral:
    case SyntaxKind.BigIntLiteral:
      return key.text;
    default:
      return undefined;
  }
}

/**
 * The key an element access names with a string literal or a template literal without
 * substitutions.
 *
 * @param access - The element access.
 * @returns The key's text, or undefined for any other key.
 */
export function literalElementKey(access: ElementAccessExpression): string | undefined {
  const key = access.argumentExpression;
  return isStringLiteral(key) || isNoSubstitutionTemplateLiteral(key) ? key.text : undefined;
}

/**
 * Whether a node is an identifier that refers to the view parameter.
 *
 * @param checker - Checker of the program holding `node`.
 * @param view - The view parameter's symbol; undefined when the callback has none.
 * @param node - The node to test.
 * @returns Whether `node` reads the view.
 */
export async function isViewReference(
  checker: Checker,
  view: CheckerSymbol | undefined,
  node: Node,
): Promise<boolean> {
  return view !== undefined && isIdentifier(node) && (await resolveSymbol(checker, node)) === view;
}

/**
 * The object pattern of the `const` or `let` declaration whose value is an expression.
 *
 * @param expr - The expression.
 * @returns The pattern, or undefined when `expr` is the value of any other declaration or
 *   assignment.
 */
export function destructuredPattern(expr: Node): ObjectBindingPattern | undefined {
  const decl = expr.parent;
  if (
    !isVariableDeclaration(decl) ||
    decl.initializer !== expr ||
    !isObjectBindingPattern(decl.name) ||
    !isVariableDeclarationList(decl.parent)
  ) {
    return undefined;
  }
  return blockScope(decl.parent) === undefined ? undefined : decl.name;
}

/**
 * The block scope a declaration list declares: `let`, `const`, or neither, for `var`, `using`, and
 * `await using`.
 *
 * @param list - The declaration list.
 * @returns `let`, `const`, or undefined.
 */
export function blockScope(list: Node): "let" | "const" | undefined {
  if ((list.flags & NodeFlags.Using) !== 0) return undefined;
  if ((list.flags & NodeFlags.Const) !== 0) return "const";
  return (list.flags & NodeFlags.Let) === 0 ? undefined : "let";
}
