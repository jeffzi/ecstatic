import {
  type ArrowFunction,
  type AsExpression,
  type BinaryOperator,
  type BindingName,
  type ConstructorDeclaration,
  type Expression,
  type FunctionExpression,
  type GetAccessorDeclaration,
  type Identifier,
  type MethodDeclaration,
  type Node,
  NodeFlags,
  type NonNullExpression,
  type ParameterDeclaration,
  type ParenthesizedExpression,
  type PropertyDeclaration,
  type SatisfiesExpression,
  type SetAccessorDeclaration,
  SyntaxKind,
  type TypeAssertion,
} from "typescript/ast";
import {
  isArrowFunction,
  isAsExpression,
  isBindingElement,
  isBreakOrContinueStatement,
  isClassLikeDeclaration,
  isComputedPropertyName,
  isConstructorDeclaration,
  isDecorator,
  isEnumMember,
  isExpressionWithTypeArguments,
  isFunctionExpression,
  isGetAccessorDeclaration,
  isHeritageClause,
  isIdentifier,
  isInterfaceDeclaration,
  isJsxAttribute,
  isLabeledStatement,
  isMetaProperty,
  isMethodDeclaration,
  isNonNullExpression,
  isParenthesizedExpression,
  isPropertyAccessExpression,
  isPropertyAssignment,
  isPropertyDeclaration,
  isSatisfiesExpression,
  isSetAccessorDeclaration,
  isSourceFile,
  isTypeAliasDeclaration,
  isTypeAssertion,
  isTypeNode,
} from "typescript/ast/is";

/** A wrapper that compiles to its operand. */
type ErasedWrapper =
  | ParenthesizedExpression
  | NonNullExpression
  | AsExpression
  | SatisfiesExpression
  | TypeAssertion;

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
 * An arrow function or function expression written in place as an argument; a function declaration
 * or a reference to one is not inline.
 */
export type InlineCallback = ArrowFunction | FunctionExpression;

/**
 * Whether a node is an inline callback.
 *
 * @param node - The node to test.
 * @returns Whether `node` is an arrow function or a function expression.
 */
export function isInlineCallback(node: Node): node is InlineCallback {
  return isArrowFunction(node) || isFunctionExpression(node);
}

/**
 * Strips the parentheses and non-null assertions around an expression, which change nothing at
 * runtime.
 *
 * @param node - The wrapped expression.
 * @returns The expression inside every such wrapper, or `node` when it has none.
 */
export function skipWrappers(node: Expression): Expression {
  let inner = node;
  while (isTransparentWrapper(inner)) inner = inner.expression;
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
  while (isErasedWrapper(inner)) inner = inner.expression;
  return inner;
}

/**
 * Strips the parentheses around an expression.
 *
 * @param node - The expression.
 * @returns The expression inside every parenthesis, or `node` when it has none.
 */
export function skipParens(node: Expression): Expression {
  let inner = node;
  while (isParenthesizedExpression(inner)) inner = inner.expression;
  return inner;
}

/**
 * Whether a node is a parenthesis or a non-null assertion, which change nothing at runtime.
 *
 * @param node - The node to test.
 * @returns Whether `node` is such a wrapper.
 */
export function isTransparentWrapper(
  node: Node,
): node is ParenthesizedExpression | NonNullExpression {
  return isParenthesizedExpression(node) || isNonNullExpression(node);
}

/**
 * Whether a node is a wrapper that compiles to its operand: parentheses, a non-null assertion, or
 * an `as`, `satisfies`, or angle-bracket type assertion.
 *
 * @param node - The node to test.
 * @returns Whether `node` is such a wrapper.
 */
export function isErasedWrapper(node: Node): node is ErasedWrapper {
  return (
    isTransparentWrapper(node) ||
    isAsExpression(node) ||
    isSatisfiesExpression(node) ||
    isTypeAssertion(node)
  );
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
 * The outermost of the parentheses and non-null assertions around a node.
 *
 * @param node - The wrapped node.
 * @returns The outermost wrapper, or `node` itself when there is none.
 */
export function outermostWrapper(node: Node): Node {
  let outer = node;
  while (isTransparentWrapper(outer.parent)) outer = outer.parent;
  return outer;
}

/**
 * The outermost of the wrappers around a node that compile to their operand: parentheses,
 * non-null assertions, and the `as`, `satisfies`, and angle-bracket type assertions.
 *
 * @param node - The wrapped node.
 * @returns The outermost wrapper, or `node` itself when there is none.
 */
export function outermostErased(node: Node): Node {
  let outer = node;
  while (isErasedWrapper(outer.parent)) outer = outer.parent;
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
 * Whether an identifier that names no declaration refers to a binding. A class's `extends`
 * expression is a reference; an `implements` clause is part of a type.
 *
 * @param id - The identifier.
 * @returns False when `id` is part of a type, a property name, a label, or the name of a
 *   meta-property; true otherwise.
 */
export function isReference(id: Identifier): boolean {
  for (let node: Node = id; !isSourceFile(node); node = node.parent) {
    if (isTypeOnly(node)) return false;
  }
  const { parent } = id;
  if ((isLabeledStatement(parent) || isBreakOrContinueStatement(parent)) && parent.label === id) {
    return false;
  }
  return !((isPropertyAccessExpression(parent) || isMetaProperty(parent)) && parent.name === id);
}

/** The keyword a variable declaration list declares with. */
export type DeclarationKind = "var" | "let" | "const" | "using" | "await using";

/**
 * The keyword a variable declaration list declares with, read from its flags. `await using` sets
 * both the `using` and the `const` flag, so the `using` flag is tested first.
 *
 * @param list - The declaration list.
 * @returns The list's keyword; `var` for a node with none of the flags.
 */
export function declarationKind(list: Node): DeclarationKind {
  if ((list.flags & NodeFlags.Using) !== 0) {
    return (list.flags & NodeFlags.Const) === 0 ? "using" : "await using";
  }
  if ((list.flags & NodeFlags.Const) !== 0) return "const";
  return (list.flags & NodeFlags.Let) === 0 ? "var" : "let";
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

/** A class or object-literal member with parameters and a body that runs when it is called. */
export type FunctionMember =
  | MethodDeclaration
  | GetAccessorDeclaration
  | SetAccessorDeclaration
  | ConstructorDeclaration;

/**
 * Whether a node is a method, accessor, or constructor.
 *
 * @param node - The node to test.
 * @returns Whether `node` is a function member.
 */
export function isFunctionMember(node: Node): node is FunctionMember {
  return (
    isMethodDeclaration(node) ||
    isGetAccessorDeclaration(node) ||
    isSetAccessorDeclaration(node) ||
    isConstructorDeclaration(node)
  );
}

/**
 * Calls `visit` on the parts of a member that run when its class or object is evaluated: its
 * modifiers, decorators among them, and its name when the name is computed.
 *
 * @param member - The class or object-literal member.
 * @param visit - Called once per part, in source order.
 */
export function visitMemberHead(
  member: FunctionMember | PropertyDeclaration,
  visit: (part: Node) => void,
): void {
  member.modifiers?.forEach((modifier) => {
    visit(modifier);
  });
  const name = isConstructorDeclaration(member) ? undefined : member.name;
  if (name !== undefined && isComputedPropertyName(name)) visit(name);
}

/**
 * Whether a child of a member's parameter runs when the class is evaluated rather than when the
 * member is called: it is one of the parameter's decorators.
 *
 * @param child - A child of a member's parameter.
 * @returns Whether `child` is a decorator.
 */
export function runsWithClass(child: Node): boolean {
  return isDecorator(child);
}

/**
 * Whether a node reads the `arguments` object of the code around it, by syntax alone: an
 * identifier named `arguments` that is a reference and not the name of a member, an enum member,
 * a JSX attribute, or the property a binding element reads. A shorthand property `{ arguments }`
 * reads it.
 *
 * @param node - The node to test.
 * @returns Whether `node` reads `arguments`.
 */
export function isArgumentsRead(node: Node): node is Identifier {
  return (
    isIdentifier(node) && node.text === "arguments" && isReference(node) && !namesProperty(node)
  );
}

/**
 * Whether an identifier names a property rather than reading a binding.
 *
 * @param id - The identifier.
 * @returns Whether `id` is the name of a property assignment, a class or object-literal member, an
 *   enum member, or a JSX attribute, or the property a binding element reads.
 */
function namesProperty(id: Identifier): boolean {
  const { parent } = id;
  if (isBindingElement(parent)) return parent.propertyName === id;
  return (
    (isPropertyAssignment(parent) ||
      isPropertyDeclaration(parent) ||
      isMethodDeclaration(parent) ||
      isGetAccessorDeclaration(parent) ||
      isSetAccessorDeclaration(parent) ||
      isEnumMember(parent) ||
      isJsxAttribute(parent)) &&
    parent.name === id
  );
}
