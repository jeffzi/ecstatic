/**
 * Static types read with the files that decide them: each read records the declaration files an
 * edit to which could change what it returns, so a rewrite that depends on the type is redone.
 */

import {
  type ForInStatement,
  type ForOfStatement,
  type Expression,
  type Node,
  type ParameterDeclaration,
  type PropertyDeclaration,
  type VariableDeclaration,
} from "typescript/ast";
import {
  isArrayBindingPattern,
  isArrowFunction,
  isBindingElement,
  isForInStatement,
  isForOfStatement,
  isFunctionDeclaration,
  isFunctionExpression,
  isGetAccessorDeclaration,
  isIdentifier,
  isMethodDeclaration,
  isObjectBindingPattern,
  isParameterDeclaration,
  isPropertyDeclaration,
  isSourceFile,
  isStatement,
  isTypeAliasDeclaration,
  isVariableDeclaration,
  isVariableDeclarationList,
} from "typescript/ast/is";

import {
  type Checker,
  type CheckerSymbol,
  declarationFileNames,
  declarationsOf,
  foreignValueFileName,
  nodeFileName,
  propertyOfType,
  resolveSymbol,
  type Type,
  typeAtLocation,
  typeOfSymbol,
  typeSymbol,
} from "../compiler.js";
import { stringLiteralValue } from "./checker-fields.js";
import type { PackageRoots } from "./roots.js";

/**
 * The static type of an expression. The checker types a value declared in another file, an
 * imported one, a property of an imported object, or the result of calling an imported function,
 * from that file, so the files declaring `expr` and every identifier under it are consulted. Each
 * identifier is also followed into its declaration, in whichever file that is, since an edit to a
 * file that declaration reads changes its type too: a variable's, parameter's, or class property's
 * annotation and initializer (through a destructuring pattern to the variable or parameter it
 * belongs to), a loop variable's iterated expression, an unannotated parameter's enclosing
 * statement, a function's, method's, or getter's return type annotation or else its body, an
 * alias's aliased type, and any other declaration's enclosing statement. A declaration in a
 * dependency, the ecstatic runtime or a file under `node_modules`, is consulted but not followed:
 * no edit in the app changes what it reads.
 *
 * @param checker - Checker of the program holding `expr`.
 * @param expr - The expression to type.
 * @param files - The consulted declaration files, which the files declaring `expr` and the
 *   identifiers under it, and under the declarations those name, join.
 * @param roots - The package roots, which locate the ecstatic runtime.
 * @returns Its static type.
 * @throws When a declaring file is no longer available, or the compiler process has exited.
 */
export async function consultedType(
  checker: Checker,
  expr: Expression,
  files: Set<string>,
  roots: PackageRoots,
): Promise<Type> {
  const [type] = await Promise.all([
    typeAtLocation(checker, expr),
    consultReads({ checker, roots, files, seen: new Set() }, expr),
  ]);
  return type;
}

/** One walk of {@link consultReads}. */
interface ReadWalk {
  readonly checker: Checker;
  readonly roots: PackageRoots;
  /** The consulted declaration files, which the declaring files join. */
  readonly files: Set<string>;
  /** The declarations already followed, by file and position, which a cycle stops at. */
  readonly seen: Set<string>;
}

/**
 * Adds the files declaring what `root` reads: each identifier under it, and under the declarations
 * of those, followed into whichever file declares them, since a value declared in another file can
 * take its type from a third. A dependency's declarations are not followed.
 *
 * @param walk - The walk, whose consulted files the declaring files join.
 * @param root - The node whose reads are consulted.
 * @throws When a declaring file is no longer available, or the compiler process has exited.
 */
async function consultReads(walk: ReadWalk, root: Node): Promise<void> {
  const { checker, files, seen } = walk;
  await Promise.all(
    readNames(root).map(async (name) => {
      const [foreign, declarations] = await Promise.all([
        foreignValueFileName(checker, name),
        declarationsOf(await resolveSymbol(checker, name)),
      ]);
      if (foreign !== undefined) files.add(foreign);
      const file = nodeFileName(name);
      await Promise.all(
        declarations.map(async (declaration) => {
          const declaringFile = nodeFileName(declaration);
          if (declaringFile !== file) files.add(declaringFile);
          if (isDependencyFile(walk.roots, declaringFile)) return;
          const key = `${declaringFile}:${declaration.pos}`;
          if (seen.has(key)) return;
          seen.add(key);
          await Promise.all(
            declaredReads(declaration).map(async (read) => consultReads(walk, read)),
          );
        }),
      );
    }),
  );
}

/**
 * Whether a file belongs to a dependency of the app: the ecstatic runtime, or any file under
 * `node_modules`, the TypeScript library files among them.
 *
 * @param roots - The package roots, which locate the ecstatic runtime.
 * @param fileName - The file's name.
 * @returns Whether the file is a dependency's.
 */
function isDependencyFile(roots: PackageRoots, fileName: string): boolean {
  return (
    roots.runtimeRoot(fileName) !== undefined || fileName.split(/[/\\]/u).includes("node_modules")
  );
}

/**
 * The parts of a declaration that decide the type of what it declares. A destructured binding is
 * decided by the variable or parameter its pattern belongs to.
 *
 * @param declaration - A declaration.
 * @returns A variable's, parameter's, or class property's annotation and initializer, in that
 *   order, with a `for-of` or `for-in` variable's iterated expression and an unannotated
 *   parameter's enclosing statement, whose call or annotation types it from context; a function's,
 *   method's, or getter's return type annotation, or its body when it has none; an alias's aliased
 *   type; for any other declaration, its enclosing statement, so a kind not listed here is read too
 *   broadly rather than not at all.
 */
function declaredReads(declaration: Node): Node[] {
  const owner = bindingOwner(declaration);
  if (
    isVariableDeclaration(owner) ||
    isParameterDeclaration(owner) ||
    isPropertyDeclaration(owner)
  ) {
    return valueReads(owner);
  }
  if (
    isFunctionDeclaration(owner) ||
    isFunctionExpression(owner) ||
    isArrowFunction(owner) ||
    isMethodDeclaration(owner) ||
    isGetAccessorDeclaration(owner)
  ) {
    const returned = owner.type ?? owner.body;
    return returned === undefined ? [] : [returned];
  }
  if (isTypeAliasDeclaration(owner)) return [owner.type];
  return [enclosingStatement(owner)];
}

/**
 * The parts that decide the type of a variable, parameter, or class property.
 *
 * @param owner - The declaration.
 * @returns Its annotation and initializer, in that order, then a `for-of` or `for-in` variable's
 *   iterated expression, or an unannotated parameter's enclosing statement.
 */
function valueReads(
  owner: VariableDeclaration | ParameterDeclaration | PropertyDeclaration,
): Node[] {
  const reads: Node[] = [];
  if (owner.type !== undefined) reads.push(owner.type);
  if (owner.initializer !== undefined) reads.push(owner.initializer);
  if (isVariableDeclaration(owner)) {
    const loop = iteratingLoop(owner);
    if (loop !== undefined) reads.push(loop.expression);
  } else if (isParameterDeclaration(owner) && owner.type === undefined) {
    reads.push(enclosingStatement(owner));
  }
  return reads;
}

/**
 * The `for-of` or `for-in` loop whose head declares a variable.
 *
 * @param variable - A variable declaration.
 * @returns The loop, or undefined when `variable` is not declared in a loop head.
 */
function iteratingLoop(variable: VariableDeclaration): ForOfStatement | ForInStatement | undefined {
  const list = variable.parent;
  if (!isVariableDeclarationList(list)) return undefined;
  const loop = list.parent;
  return isForOfStatement(loop) || isForInStatement(loop) ? loop : undefined;
}

/**
 * The nearest statement holding a node.
 *
 * @param node - The node.
 * @returns The innermost statement that is `node` or holds it, or its source file when none does.
 */
function enclosingStatement(node: Node): Node {
  let current = node;
  while (!isStatement(current) && !isSourceFile(current)) current = current.parent;
  return current;
}

/**
 * The declaration a binding element belongs to, found by walking up through its binding patterns.
 *
 * @param declaration - A declaration.
 * @returns The enclosing variable or parameter declaration of a binding element; `declaration`
 *   itself for any other node.
 */
function bindingOwner(declaration: Node): Node {
  let node = declaration;
  while (isBindingElement(node) || isObjectBindingPattern(node) || isArrayBindingPattern(node)) {
    node = node.parent;
  }
  return node;
}

/**
 * The nodes of a tree that read a declared value: the node itself and every identifier under it, in
 * source order.
 *
 * @param root - The node to read.
 * @returns `root` first, then each identifier below it.
 */
function readNames(root: Node): Node[] {
  const names: Node[] = [root];
  const visit = (node: Node): void => {
    if (isIdentifier(node)) names.push(node);
    node.forEachChild(visit);
  };
  root.forEachChild(visit);
  return names;
}

/**
 * The component name a descriptor type pins: its `__ecstatic_name`, which must be a single string
 * literal.
 *
 * @param checker - Checker that produced `type`.
 * @param type - A component descriptor type.
 * @param files - The consulted declaration files, which the declarations of `__ecstatic_name` join.
 * @returns The name, or undefined when `type` does not pin one, as a union of names does not.
 * @throws When a declaration's source file is no longer available, or the compiler process has
 *   exited.
 */
export async function componentName(
  checker: Checker,
  type: Type,
  files: Set<string>,
): Promise<string | undefined> {
  return stringLiteralValue(await consultedProperty(checker, type, "__ecstatic_name", files));
}

/**
 * The type of a property, whose declarations are consulted.
 *
 * @param checker - Checker that produced `type`.
 * @param type - Type holding the property.
 * @param name - Property name.
 * @param files - The consulted declaration files, which the property's declarations join.
 * @returns The property's type, or undefined when `type` has no such property.
 * @throws When a declaration's source file is no longer available, or the compiler process has
 *   exited.
 */
export async function consultedProperty(
  checker: Checker,
  type: Type,
  name: string,
  files: Set<string>,
): Promise<Type | undefined> {
  const symbol = await propertyOfType(checker, type, name);
  if (symbol === undefined) return undefined;
  const [, propertyType] = await Promise.all([
    consultDeclarations(symbol, files),
    typeOfSymbol(checker, symbol),
  ]);
  return propertyType;
}

/**
 * Adds the files declaring a symbol to the consulted declaration files.
 *
 * @param symbol - The symbol; undefined when the type has none, which declares nothing.
 * @param files - The consulted declaration files, which the symbol's declaring files join.
 * @throws When a declaration's source file is no longer available, or the compiler process has
 *   exited.
 */
export async function consultDeclarations(
  symbol: CheckerSymbol | undefined,
  files: Set<string>,
): Promise<void> {
  for (const file of await declarationFileNames(symbol)) files.add(file);
}

/**
 * Adds the files declaring a type's symbol to the consulted declaration files.
 *
 * @param type - The type; one with no symbol, such as a primitive, declares nothing.
 * @param files - The consulted declaration files, which the files declaring the type's symbol join.
 * @throws When a declaration's source file is no longer available, or the compiler process has
 *   exited.
 */
export async function consultTypeDeclarations(type: Type, files: Set<string>): Promise<void> {
  await consultDeclarations(await typeSymbol(type), files);
}
