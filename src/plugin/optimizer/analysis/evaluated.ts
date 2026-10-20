import {
  type ArrowFunction,
  type ConstructorDeclaration,
  type FunctionDeclaration,
  type FunctionExpression,
  type GetAccessorDeclaration,
  type MethodDeclaration,
  ModifierFlags,
  type Node,
  type PropertyDeclaration,
  type SetAccessorDeclaration,
} from "typescript/ast";
import {
  isArrowFunction,
  isComputedPropertyName,
  isConstructorDeclaration,
  isDecorator,
  isFunctionDeclaration,
  isFunctionExpression,
  isGetAccessorDeclaration,
  isMethodDeclaration,
  isPropertyDeclaration,
  isSetAccessorDeclaration,
} from "typescript/ast/is";

import { isTypeOnly } from "../syntax.js";

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
 * Whether a node is an arrow function, a function expression, or a function declaration: code that
 * runs only when called.
 *
 * @param node - The node to test.
 * @returns Whether `node` is a nested function.
 */
export function isNestedFunction(
  node: Node,
): node is ArrowFunction | FunctionExpression | FunctionDeclaration {
  return isArrowFunction(node) || isFunctionExpression(node) || isFunctionDeclaration(node);
}

/**
 * Calls `visit` on each child of `node` that runs when `node` runs.
 *
 * A nested function runs only when called, so none of it does. A class or object-literal member is
 * the exception: its decorators, its computed name, its parameters' decorators, and a static
 * field's initializer run with the class or object. A class's own children and a static block's
 * body run with it. Type positions never run.
 *
 * @param node - The node whose evaluated children to visit.
 * @param visit - Called once per evaluated child, in source order.
 */
export function forEachEvaluated(node: Node, visit: (child: Node) => void): void {
  if (isNestedFunction(node)) return;
  if (isFunctionMember(node)) {
    visitMemberHead(node, visit);
    visitParameterDecorators(node, visit);
    return;
  }
  if (isPropertyDeclaration(node)) {
    visitMemberHead(node, visit);
    if (node.initializer !== undefined && isStatic(node)) visit(node.initializer);
    return;
  }
  node.forEachChild((child) => {
    if (!isTypeOnly(child)) visit(child);
  });
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
 * Calls `visit` on each part of a class or object-literal member that runs only when the member is
 * called or, for an instance field's initializer, when an instance is built: the parts of a member
 * that {@link forEachEvaluated} leaves out. A parameter's decorators run with the class, so they are
 * not among them. Any other node has no such part.
 *
 * @param node - The node whose deferred parts to visit.
 * @param visit - Called once per deferred part, in source order.
 */
export function forEachDeferred(node: Node, visit: (part: Node) => void): void {
  if (isFunctionMember(node)) {
    for (const param of node.parameters) {
      param.forEachChild((child) => {
        if (!runsWithClass(child)) visit(child);
      });
    }
    if (node.body !== undefined) visit(node.body);
  } else if (isPropertyDeclaration(node) && node.initializer !== undefined && !isStatic(node)) {
    visit(node.initializer);
  }
}

/**
 * Whether a node is the initializer of an instance field, which runs each time an instance is
 * built rather than when the class is evaluated.
 *
 * @param member - The node's parent.
 * @param node - The node to test.
 * @returns Whether `node` is the initializer of `member`, an instance field.
 */
export function isInstanceInitializer(member: Node, node: Node): boolean {
  return isPropertyDeclaration(member) && member.initializer === node && !isStatic(member);
}

function visitParameterDecorators(member: FunctionMember, visit: (part: Node) => void): void {
  for (const param of member.parameters) {
    param.forEachChild((child) => {
      if (runsWithClass(child)) visit(child);
    });
  }
}

function isStatic(member: PropertyDeclaration): boolean {
  return (member.modifierFlags & ModifierFlags.Static) !== 0;
}
