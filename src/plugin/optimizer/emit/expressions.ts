/**
 * The expressions and declarations the inlined loop is built from, through the factory alone.
 */

import {
  type BinaryOperator,
  type BindingName,
  type Expression,
  type Node,
  NodeFlags,
  type Statement,
  SyntaxKind,
  TokenFlags,
  type VariableDeclaration,
} from "typescript/ast";
import {
  createBinaryExpression,
  createConditionalExpression,
  createElementAccessExpression,
  createIdentifier,
  createKeywordExpression,
  createNumericLiteral,
  createParenthesizedExpression,
  createPropertyAccessExpression,
  createStringLiteral,
  createToken,
  createVariableDeclaration,
  createVariableDeclarationList,
  createVariableStatement,
  createVoidExpression,
} from "typescript/ast/factory";
import {
  isElementAccessExpression,
  isExpression,
  isExpressionStatement,
  isIdentifier,
  isParenthesizedExpression,
  isPropertyAccessExpression,
} from "typescript/ast/is";

import type { ViewUse } from "../facts.js";
import { outermostParens, skipWrappers } from "../syntax.js";

/** Visits a node of the body, returning what it becomes. */
export type Visit = (node: Node) => Node;

/** The names a property access can spell; any other name is read with an element access. */
export const IDENTIFIER_NAME = /^[A-Za-z_$][\w$]*$/u;

/**
 * A variable declaration.
 *
 * @param name - The name declared, or a pattern.
 * @param initializer - Its value, if any.
 * @returns `name = initializer`, or `name` alone.
 */
export function declaration(
  name: string | BindingName,
  initializer?: Expression,
): VariableDeclaration {
  const bound = typeof name === "string" ? createIdentifier(name) : name;
  return createVariableDeclaration(bound, undefined, undefined, initializer);
}

/**
 * A `const` statement.
 *
 * @param declarations - What it declares.
 * @returns The statement.
 */
export function constStatement(declarations: readonly VariableDeclaration[]): Statement {
  return createVariableStatement(
    undefined,
    createVariableDeclarationList(declarations, NodeFlags.Const),
  );
}

/**
 * A `let` statement.
 *
 * @param declarations - What it declares.
 * @returns The statement.
 */
export function letStatement(declarations: readonly VariableDeclaration[]): Statement {
  return createVariableStatement(
    undefined,
    createVariableDeclarationList(declarations, NodeFlags.Let),
  );
}

/**
 * A binary expression.
 *
 * @param left - The left operand.
 * @param operator - The operator.
 * @param right - The right operand.
 * @returns `left operator right`.
 */
export function binary(left: Expression, operator: BinaryOperator, right: Expression): Expression {
  return createBinaryExpression(undefined, left, undefined, createToken(operator), right);
}

/**
 * A numeric literal.
 *
 * @param text - How it is spelled.
 * @returns The literal.
 */
export function numeric(text: string): Expression {
  return createNumericLiteral(text, TokenFlags.None);
}

/**
 * A member read.
 *
 * @param object - The object read from.
 * @param name - The member's name.
 * @returns `object.name`, or `object["name"]` when `name` is no identifier.
 */
export function member(object: Expression, name: string): Expression {
  if (IDENTIFIER_NAME.test(name)) {
    return createPropertyAccessExpression(
      object,
      undefined,
      createIdentifier(name),
      NodeFlags.None,
    );
  }
  return createElementAccessExpression(
    object,
    undefined,
    createStringLiteral(name, TokenFlags.None),
    NodeFlags.None,
  );
}

/**
 * An expression in parentheses, so the printer keeps the lowering's grouping wherever it lands.
 *
 * @param expression - The expression.
 * @returns `(expression)`.
 */
export function parenthesized(expression: Expression): Expression {
  return createParenthesizedExpression(expression);
}

/**
 * Expressions evaluated in order as one.
 *
 * @param expressions - The expressions, first to last.
 * @returns `(first, ..., last)`, which yields the last expression's value, or the one expression
 *   alone.
 */
export function commaList(...expressions: readonly [...Expression[], Expression]): Expression {
  if (expressions.length === 1) return expressions[0];
  return parenthesized(
    expressions.reduce((list, next) => binary(list, SyntaxKind.CommaToken, next)),
  );
}

/**
 * An assignment.
 *
 * @param target - What is assigned.
 * @param value - The value assigned.
 * @returns `target = value`.
 */
export function assignTo(target: Expression, value: Expression): Expression {
  return binary(target, SyntaxKind.EqualsToken, value);
}

/**
 * The boolean field getter's decoding of a stored element.
 *
 * @param element - The stored element.
 * @returns `(element !== 0)`.
 */
export function decode(element: Expression): Expression {
  return parenthesized(binary(element, SyntaxKind.ExclamationEqualsEqualsToken, numeric("0")));
}

/**
 * The boolean field setter's encoding of the value it is given, as `fieldAccessorsFor`
 * (`src/ecstatic/entity/each.ts`) builds it.
 *
 * @param value - The value assigned.
 * @returns `(value === true ? 1 : 0)`.
 */
export function encode(value: Expression): Expression {
  const isTrue = binary(value, SyntaxKind.EqualsEqualsEqualsToken, keyword(SyntaxKind.TrueKeyword));
  return conditional(isTrue, numeric("1"), numeric("0"));
}

/**
 * A conditional expression.
 *
 * @param condition - The test.
 * @param whenTrue - The value when the test holds.
 * @param whenFalse - The value otherwise.
 * @returns `(condition ? whenTrue : whenFalse)`.
 */
export function conditional(
  condition: Expression,
  whenTrue: Expression,
  whenFalse: Expression,
): Expression {
  return parenthesized(
    createConditionalExpression(
      condition,
      createToken(SyntaxKind.QuestionToken),
      whenTrue,
      createToken(SyntaxKind.ColonToken),
      whenFalse,
    ),
  );
}

/**
 * A value guarded by a condition.
 *
 * @param condition - The test.
 * @param whenTrue - The value when the test holds.
 * @returns `(condition ? whenTrue : undefined)`.
 */
export function orUndefined(condition: Expression, whenTrue: Expression): Expression {
  return conditional(condition, whenTrue, createVoidExpression(numeric("0")));
}

/**
 * A `true` or `false` literal.
 *
 * @param kind - The keyword.
 * @returns The keyword expression.
 */
export function keyword(kind: SyntaxKind.TrueKeyword | SyntaxKind.FalseKeyword): Expression {
  return createKeywordExpression(kind);
}

/**
 * Strips the parentheses around an expression.
 *
 * @param node - The parenthesized expression.
 * @returns The expression inside every parenthesis.
 */
export function skipParens(node: Expression): Expression {
  let inner = node;
  while (isParenthesizedExpression(inner)) inner = inner.expression;
  return inner;
}

/**
 * Whether the value of an expression may be read: it is not the whole of an expression statement.
 *
 * @param node - The expression.
 * @returns Whether its value is used.
 */
export function isValueUsed(node: Node): boolean {
  return !isExpressionStatement(outermostParens(node).parent);
}

/**
 * Whether an expression spells `null` or `undefined`.
 *
 * @param node - The expression.
 * @returns Whether it is a nullish literal.
 */
export function isNullishLiteral(node: Expression): boolean {
  const inner = skipWrappers(node);
  return (
    inner.kind === SyntaxKind.NullKeyword || (isIdentifier(inner) && inner.text === "undefined")
  );
}

/**
 * The slot expression of a field use: `e.C` in `e.C.f`.
 *
 * @param node - The field access.
 * @param use - The field use.
 * @returns The expression the field is read from.
 * @throws Error when `node` is no member access.
 */
export function slotOf(node: Node, use: ViewUse): Expression {
  const access = isExpression(node) ? skipParens(node) : node;
  if (isPropertyAccessExpression(access) || isElementAccessExpression(access)) {
    return access.expression;
  }
  throw new Error(`emit: the field use of ${use.comp}.${use.field} is no member access`);
}
