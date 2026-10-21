/**
 * The rules a callback body applies by what its own code uses and declares, once the rewrite moves
 * it as written into the row loop: block-scoped declarations, closures, `this`, `arguments`,
 * `new.target`, `super`, labels, throws, and references to bindings outside the callback.
 */

import { type Identifier, type Node, NodeFlags, type Statement, SyntaxKind } from "typescript/ast";
import {
  isArrowFunction,
  isBindingElement,
  isBlock,
  isClassDeclaration,
  isClassExpression,
  isClassStaticBlockDeclaration,
  isFunctionDeclaration,
  isFunctionExpression,
  isFunctionLikeDeclaration,
  isIdentifier,
  isMetaProperty,
  isMethodDeclaration,
  isModuleBlock,
  isParameterDeclaration,
  isPropertyAccessExpression,
  isPropertyAssignment,
  isPropertyDeclaration,
  isSourceFile,
  isTypeNode,
  isVariableDeclaration,
  isVariableStatement,
} from "typescript/ast/is";

import { boundNames } from "../syntax.js";
import type { Rule } from "./catalog.js";

/** The rule a node of the callback's body applies by its kind alone. */
const KIND_RULES: ReadonlyMap<SyntaxKind, Rule> = new Map([
  [SyntaxKind.LabeledStatement, "user-label"],
  [SyntaxKind.BreakStatement, "user-label"],
  [SyntaxKind.ContinueStatement, "user-label"],
  [SyntaxKind.ClassDeclaration, "block-scoped-declaration"],
  [SyntaxKind.FunctionDeclaration, "block-scoped-declaration"],
  [SyntaxKind.ArrowFunction, "closure"],
  [SyntaxKind.FunctionExpression, "closure"],
  [SyntaxKind.MethodDeclaration, "closure"],
  [SyntaxKind.ThisKeyword, "this"],
  [SyntaxKind.SuperKeyword, "super"],
  [SyntaxKind.ThrowStatement, "throw"],
]);

/**
 * The transplant rule a node of the callback's body, moved as written, applies.
 *
 * @param node - The node.
 * @returns The rule of a block-scoped declaration, a function the body creates, `this`,
 *   `arguments`, `new.target`, `super`, a label, or a throw; undefined for any other node.
 */
export function bodyRule(node: Node): Rule | undefined {
  const rule = KIND_RULES.get(node.kind);
  if (rule !== undefined) return rule;
  if (
    node.kind === SyntaxKind.VariableDeclarationList &&
    (node.flags & NodeFlags.BlockScoped) !== 0
  ) {
    return "block-scoped-declaration";
  }
  if (isMetaProperty(node) && node.keywordToken === SyntaxKind.NewKeyword) return "new-target";
  const isArguments =
    isIdentifier(node) &&
    node.text === "arguments" &&
    !(isPropertyAccessExpression(node.parent) && node.parent.name === node);
  return isArguments ? "arguments" : undefined;
}

/** The rules a use of the callback's own `this` binding applies. */
const OWN_THIS_RULES: ReadonlySet<Rule> = new Set(["this", "arguments", "super", "new-target"]);

/** The rules that apply only outside every function nested in the callback, arrows included. */
const OWN_SCOPE_RULES: ReadonlySet<Rule> = new Set([
  "block-scoped-declaration",
  "user-label",
  "throw",
  "outer-let-dead-zone",
]);

/**
 * Whether a node of a callback applies a rule as the callback's own code. `this`, `arguments`,
 * `super`, and `new.target` are the callback's own outside code that binds its own; a block-scoped
 * declaration, a label, a throw, and a dead-zone read are its own outside any function nested in
 * it, arrows included.
 *
 * @param node - The node, inside `callback`.
 * @param callback - The callback.
 * @param rule - The rule `node` applies.
 * @returns Whether the rule applies to the callback.
 */
export function inOwnCode(node: Node, callback: Node, rule: Rule): boolean {
  const ownScope = OWN_SCOPE_RULES.has(rule);
  if (!ownScope && !OWN_THIS_RULES.has(rule)) return true;
  for (let child = node; child.parent !== callback; child = child.parent) {
    const { parent } = child;
    if ((ownScope && isArrowFunction(parent)) || entersOwnThis(child, parent)) return false;
  }
  return true;
}

/**
 * Whether a child of a node is code that binds its own `this`, `arguments`, and `new.target`: a
 * non-arrow function, the parameters or body of a method, accessor, or constructor, a class
 * field's initializer, or a class static block. A member's decorators and computed name are not.
 *
 * @param child - The child.
 * @param parent - Its parent.
 * @returns Whether `child` binds its own.
 */
function entersOwnThis(child: Node, parent: Node): boolean {
  if (isClassStaticBlockDeclaration(parent) || isFunctionExpression(parent)) return true;
  if (isPropertyDeclaration(parent)) return child === parent.initializer;
  if (!isFunctionLikeDeclaration(parent) || isArrowFunction(parent)) return false;
  return isFunctionDeclaration(parent) || child === parent.body || isParameterDeclaration(child);
}

/**
 * The references of a callback to bindings outside it.
 *
 * @param callback - The callback.
 * @returns The identifiers of `callback`, in source order, that refer to a binding by a name no
 *   parameter or declaration of `callback` binds.
 */
export function outerReferences(callback: Node): Identifier[] {
  const declared = new Set<string>();
  const references: Identifier[] = [];
  const walk = (node: Node): void => {
    if (isIdentifier(node)) {
      if (isDeclarationName(node)) declared.add(node.text);
      else if (isReference(node)) references.push(node);
    }
    node.forEachChild(walk);
  };
  walk(callback);
  return references.filter((reference) => !declared.has(reference.text));
}

function isDeclarationName(id: Identifier): boolean {
  const { parent } = id;
  return (
    (isVariableDeclaration(parent) ||
      isParameterDeclaration(parent) ||
      isBindingElement(parent) ||
      isFunctionDeclaration(parent) ||
      isFunctionExpression(parent) ||
      isClassDeclaration(parent) ||
      isClassExpression(parent) ||
      isMethodDeclaration(parent) ||
      isPropertyDeclaration(parent) ||
      isPropertyAssignment(parent)) &&
    parent.name === id
  );
}

/**
 * Whether an identifier that names no declaration refers to a binding.
 *
 * @param id - The identifier.
 * @returns False when `id` is part of a type, a property name, a label, or the name of a
 *   meta-property; true otherwise.
 */
function isReference(id: Identifier): boolean {
  for (let node: Node = id; !isSourceFile(node); node = node.parent) {
    if (isTypeNode(node)) return false;
  }
  const { parent } = id;
  if (KIND_RULES.get(parent.kind) === "user-label") return false;
  return !((isPropertyAccessExpression(parent) || isMetaProperty(parent)) && parent.name === id);
}

/**
 * Whether a read in the callback of a call reads a `let`, `const`, or class still in its dead zone:
 * one that a statement list enclosing the call, up to the function holding it, declares after the
 * call starts, so the read throws. The nearest declaration decides; a `var` or function declaration
 * has no dead zone.
 *
 * @param name - The name read.
 * @param call - The inlined call.
 * @returns Whether the read throws.
 */
export function inDeadZone(name: string, call: Node): boolean {
  for (let node = call.parent; ; node = node.parent) {
    const statements =
      isBlock(node) || isSourceFile(node) || isModuleBlock(node) ? node.statements : [];
    for (const statement of statements) {
      const declared = declarationOf(statement, name);
      if (declared !== undefined) return declared.blockScoped && statement.end > call.pos;
    }
    if (isSourceFile(node) || isCodeBoundary(node)) return false;
  }
}

/**
 * Whether a node bounds the code around a call, for both the labels it reaches and the dead zones
 * of the names it reads: a function or a class static block.
 *
 * @param node - The node to test.
 * @returns Whether `node` is a function or a class static block.
 */
export function isCodeBoundary(node: Node): boolean {
  return isFunctionLikeDeclaration(node) || isClassStaticBlockDeclaration(node);
}

/**
 * How a statement declares a name, at any depth of its binding patterns.
 *
 * @param statement - A statement of a statement list.
 * @param name - The name.
 * @returns Whether the declaration is a `let`, `const`, or class, which has a dead zone; undefined
 *   when `statement` does not declare `name`.
 */
function declarationOf(statement: Statement, name: string): { blockScoped: boolean } | undefined {
  if (isVariableStatement(statement)) {
    const { declarationList } = statement;
    const declares = declarationList.declarations.some((candidate) =>
      boundNames(candidate.name).includes(name),
    );
    if (!declares) return undefined;
    return { blockScoped: (declarationList.flags & NodeFlags.BlockScoped) !== 0 };
  }
  if (isClassDeclaration(statement) || isFunctionDeclaration(statement)) {
    if (statement.name?.text !== name) return undefined;
    return { blockScoped: isClassDeclaration(statement) };
  }
  return undefined;
}
