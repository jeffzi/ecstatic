/**
 * The expressions and declarations the inlined loop is built from, through the factory alone, and
 * the reads of a source expression's shape the lowering keys on.
 */

import {
  type BinaryOperator,
  type BindingName,
  type Expression,
  getSynthesizedDeepClone,
  type Node,
  NodeFlags,
  type ObjectLiteralElementLike,
  type PropertyName,
  type Statement,
  type StringLiteral,
  SyntaxKind,
  TokenFlags,
  type VariableDeclaration,
} from "typescript/ast";
import {
  createBinaryExpression,
  createCallExpression,
  createConditionalExpression,
  createElementAccessExpression,
  createIdentifier,
  createKeywordExpression,
  createNumericLiteral,
  createParenthesizedExpression,
  createPropertyAccessExpression,
  createPropertyAssignment,
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
  isPropertyAccessExpression,
} from "typescript/ast/is";

import type { ViewUse } from "../facts.js";
import { outermostParens, skipParens } from "../syntax.js";

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
 * A string literal.
 *
 * @param text - The string's value.
 * @returns The literal.
 */
export function string(text: string): StringLiteral {
  return createStringLiteral(text, TokenFlags.None);
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
  return elementAt(object, string(name));
}

/**
 * An element read by index.
 *
 * @param array - The array read from.
 * @param index - The index.
 * @returns `array[index]`.
 */
export function elementAt(array: Expression, index: Expression): Expression {
  return createElementAccessExpression(array, undefined, index, NodeFlags.None);
}

/**
 * `key: value` in an object literal or assignment pattern.
 *
 * @param key - The property name.
 * @param value - The value, or the assignment target.
 * @returns The property assignment.
 */
export function propertyAssignment(key: PropertyName, value: Expression): ObjectLiteralElementLike {
  // @ts-expect-error -- the generated factory types the type annotation as required, though a property assignment never has one
  return createPropertyAssignment(undefined, key, undefined, undefined, value);
}

/**
 * A call of a member of the internal entry's namespace import.
 *
 * @param namespace - The name of the namespace import.
 * @param name - The member called.
 * @param args - The arguments.
 * @returns `namespace.name(...args)`.
 */
export function namespaceCall(
  namespace: string,
  name: string,
  args: readonly Expression[],
): Expression {
  return createCallExpression(
    member(createIdentifier(namespace), name),
    undefined,
    undefined,
    args,
    NodeFlags.None,
  );
}

/**
 * A check that runs only where the runtime's `DEBUG` holds. The gate is a parenthesized copy of
 * the runtime's `DEBUG` initializer, which reads no binding of the file, so the check runs even
 * before the module's body has.
 *
 * @param debug - The runtime's `DEBUG` initializer.
 * @param check - The check.
 * @returns `(<DEBUG initializer>) && check`.
 */
export function debugGated(debug: Expression, check: Expression): Expression {
  const gate = parenthesized(getSynthesizedDeepClone(debug));
  return binary(gate, SyntaxKind.AmpersandAmpersandToken, check);
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
  return conditional(condition, whenTrue, undefinedValue());
}

/**
 * The `undefined` value, spelled so no binding named `undefined` can shadow it.
 *
 * @returns `void 0`.
 */
export function undefinedValue(): Expression {
  return createVoidExpression(numeric("0"));
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
 * Whether the value of an expression may be read: it is not the whole of an expression statement.
 *
 * @param node - The expression.
 * @returns Whether its value is used.
 */
export function isValueUsed(node: Node): boolean {
  return !isExpressionStatement(outermostParens(node).parent);
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
