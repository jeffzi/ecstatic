/** Finds the shape guards in rewritten modules that can run while the runtime's `DEBUG` is false. */
import {
  type BindingName,
  type ClassDeclaration,
  type ClassExpression,
  type Expression,
  type FunctionLikeDeclaration,
  type NamedImportBindings,
  type NamedImports,
  type Node,
  NodeFlags,
  type SourceFile,
  type Statement,
  SyntaxKind,
} from "typescript/ast";
import {
  isBinaryExpression,
  isBindingElement,
  isBlock,
  isCallExpression,
  isCaseBlock,
  isCatchClause,
  isClassDeclaration,
  isClassExpression,
  isEnumDeclaration,
  isForInStatement,
  isForOfStatement,
  isForStatement,
  isFunctionDeclaration,
  isFunctionExpression,
  isFunctionLikeDeclaration,
  isIdentifier,
  isImportDeclaration,
  isLiteralExpression,
  isLiteralLikeNode,
  isModuleBlock,
  isModuleDeclaration,
  isNamedImports,
  isNamespaceImport,
  isParenthesizedExpression,
  isPostfixUnaryExpression,
  isPrefixUnaryExpression,
  isPropertyAccessExpression,
  isStringLiteral,
  isVariableDeclarationList,
  isVariableStatement,
} from "typescript/ast/is";

/** The module the emitter imports the shape guard's namespace from. */
const INTERNAL_ENTRY = "ecstatic/internal";

/** The export of {@link INTERNAL_ENTRY} that a shape guard calls. */
const SHAPE_GUARD = "assertShape";

/** The names the emitter gives a file's `DEBUG` copy: `DEBUG`, or `DEBUG_<n>` when the file already binds `DEBUG`. */
const DEBUG_COPY = /^DEBUG(?:_[1-9]\d*)?$/u;

/** The problem reported when no module holds a shape guard, so that the check cannot pass vacuously. */
export const NO_GUARDS =
  "no test module's output holds a shape guard, so the check has nothing to check";

/** An identifier an `&&` expression requires to be true before its right operand runs. */
interface Gate {
  readonly name: string;
  /** Whether a binding of a function, block, catch clause, class, or for statement declares the name there. */
  readonly local: boolean;
}

/** One shape guard call and the gates around it, outermost first. */
interface Guard {
  readonly call: Node;
  readonly gates: readonly Gate[];
}

/** The local names through which a file calls the shape guard of {@link INTERNAL_ENTRY}. */
interface GuardImports {
  readonly namespaces: ReadonlySet<string>;
  readonly functions: ReadonlySet<string>;
}

/** What {@link collectGuards} reads and gathers while it walks one file. */
interface GuardWalk {
  readonly imports: GuardImports;
  readonly found: Guard[];
}

/** The names one function, block, catch clause, class, or for statement binds, inside the scopes around it. */
interface Scope {
  readonly outer: Scope | undefined;
  readonly names: ReadonlySet<string>;
}

/** Whether `scope`, or a scope around it, binds `name`; the file's top level is no scope. */
function binds(scope: Scope | undefined, name: string): boolean {
  for (let inner = scope; inner !== undefined; inner = inner.outer) {
    if (inner.names.has(name)) return true;
  }
  return false;
}

/** The scope the children of `node` run in: `scope` itself when `node` binds no name for them. */
function enter(scope: Scope | undefined, node: Node): Scope | undefined {
  const names = new Set<string>();
  scopeBindings(node, names);
  return names.size === 0 ? scope : { outer: scope, names };
}

function isClass(node: Node): node is ClassDeclaration | ClassExpression {
  return isClassDeclaration(node) || isClassExpression(node);
}

/** Adds to `names` every identifier `name`, an identifier or a destructuring pattern, binds. */
function bindingNames(name: BindingName | undefined, names: Set<string>): void {
  if (name === undefined) return;
  if (isIdentifier(name)) {
    names.add(name.text);
    return;
  }
  for (const element of name.elements) {
    if (isBindingElement(element)) bindingNames(element.name, names);
  }
}

/** Adds to `names` every name `list` binds when it is a variable declaration list that is block-scoped exactly when `blockScoped` is. */
function declarationListNames(
  list: Node | undefined,
  blockScoped: boolean,
  names: Set<string>,
): void {
  if (list === undefined || !isVariableDeclarationList(list)) return;
  const isBlockScoped = (list.flags & NodeFlags.BlockScoped) !== 0;
  if (isBlockScoped !== blockScoped) return;
  for (const declaration of list.declarations) bindingNames(declaration.name, names);
}

/** Adds to `names` every name a `var` declaration in `node` binds, leaving out the functions and classes inside it. */
function hoistedVars(node: Node, names: Set<string>): void {
  declarationListNames(node, false, names);
  node.forEachChild((child) => {
    if (!isFunctionLikeDeclaration(child) && !isClass(child)) hoistedVars(child, names);
  });
}

/** Adds to `names` every name `statements`, the statements of one block, declare for that block alone. */
function lexicalBindings(statements: readonly Statement[], names: Set<string>): void {
  for (const statement of statements) {
    if (isVariableStatement(statement)) {
      declarationListNames(statement.declarationList, true, names);
    } else if (
      isFunctionDeclaration(statement) ||
      isClassDeclaration(statement) ||
      isEnumDeclaration(statement) ||
      isModuleDeclaration(statement)
    ) {
      const name = statement.name;
      if (name !== undefined && isIdentifier(name)) names.add(name.text);
    }
  }
}

/** Adds to `names` every name `fn` binds for its body: its parameters, its own name as an expression, and its `var`s. */
function functionBindings(fn: FunctionLikeDeclaration, names: Set<string>): void {
  for (const parameter of fn.parameters) bindingNames(parameter.name, names);
  if (isFunctionExpression(fn)) bindingNames(fn.name, names);
  if (fn.body !== undefined) hoistedVars(fn.body, names);
}

/** Adds to `names` every name `node` binds for its children alone, when `node` opens a scope. */
function scopeBindings(node: Node, names: Set<string>): void {
  if (isFunctionLikeDeclaration(node)) {
    functionBindings(node, names);
  } else if (isClass(node)) {
    bindingNames(node.name, names);
  } else if (isCatchClause(node)) {
    bindingNames(node.variableDeclaration?.name, names);
  } else {
    blockBindings(node, names);
  }
}

/** Adds to `names` every name `node` binds for its children alone, when `node` is a block, a case block, or a `for` statement. */
function blockBindings(node: Node, names: Set<string>): void {
  if (isBlock(node) || isModuleBlock(node)) {
    lexicalBindings(node.statements, names);
  } else if (isCaseBlock(node)) {
    for (const clause of node.clauses) lexicalBindings(clause.statements, names);
  } else if (isForStatement(node) || isForInStatement(node) || isForOfStatement(node)) {
    declarationListNames(node.initializer, true, names);
  }
}

/** The name and initializer of `statement` when it is a `const` declaring one identifier with an initializer. */
function soleConst(statement: Statement): { name: string; initializer: Expression } | undefined {
  if (!isVariableStatement(statement)) return undefined;
  const list = statement.declarationList;
  const [declaration, ...rest] = list.declarations;
  const scoping: NodeFlags = list.flags & NodeFlags.BlockScoped;
  if (scoping !== NodeFlags.Const) return undefined;
  if (declaration === undefined || rest.length > 0 || !isIdentifier(declaration.name)) {
    return undefined;
  }
  const { initializer } = declaration;
  return initializer === undefined ? undefined : { name: declaration.name.text, initializer };
}

/** The named bindings of `statement` when it is a value import of {@link INTERNAL_ENTRY}. */
function internalBindings(statement: Statement): NamedImportBindings | undefined {
  if (!isImportDeclaration(statement)) return undefined;
  const { importClause: clause, moduleSpecifier: specifier } = statement;
  if (clause === undefined || !isStringLiteral(specifier) || specifier.text !== INTERNAL_ENTRY) {
    return undefined;
  }
  return clause.phaseModifier === SyntaxKind.TypeKeyword ? undefined : clause.namedBindings;
}

/** Every local name through which `file` can call the shape guard of {@link INTERNAL_ENTRY}. */
function internalImports(file: SourceFile): GuardImports {
  const namespaces = new Set<string>();
  const functions = new Set<string>();
  for (const statement of file.statements) {
    const bindings = internalBindings(statement);
    if (bindings === undefined) continue;
    if (isNamespaceImport(bindings)) {
      namespaces.add(bindings.name.text);
    } else if (isNamedImports(bindings)) {
      guardFunctionNames(bindings, functions);
    }
  }
  return { namespaces, functions };
}

/** Adds to `names` every local name `imports` gives the shape guard as a value. */
function guardFunctionNames(imports: NamedImports, names: Set<string>): void {
  for (const specifier of imports.elements) {
    const imported = specifier.propertyName ?? specifier.name;
    if (!specifier.isTypeOnly && imported.text === SHAPE_GUARD) names.add(specifier.name.text);
  }
}

/**
 * The `DEBUG` copy a rewritten file carries: the `const` named `DEBUG` or `DEBUG_<n>` right after
 * the namespace import of {@link INTERNAL_ENTRY} that opens its preamble.
 *
 * @param file - The parsed module.
 * @returns The copy's name and initializer, or `undefined` when the file has no such copy right
 *   after the namespace import.
 */
function debugCopyOf(file: SourceFile): { name: string; initializer: Expression } | undefined {
  const statements = file.statements;
  const namespaceImportAt = statements.findIndex((statement) => {
    const bindings = internalBindings(statement);
    return bindings !== undefined && isNamespaceImport(bindings);
  });
  const afterImport = namespaceImportAt < 0 ? undefined : statements[namespaceImportAt + 1];
  const copy = afterImport === undefined ? undefined : soleConst(afterImport);
  return copy !== undefined && DEBUG_COPY.test(copy.name) ? copy : undefined;
}

/** The text of `node`, inside any parentheses, when it is an identifier, and `""` otherwise. */
function identifierName(node: Node): string {
  let inner = node;
  while (isParenthesizedExpression(inner)) inner = inner.expression;
  return isIdentifier(inner) ? inner.text : "";
}

/** Whether `node` calls the shape guard through one of `imports`. */
function callsGuard(node: Node, imports: GuardImports): boolean {
  if (!isCallExpression(node)) return false;
  const callee = node.expression;
  if (!isPropertyAccessExpression(callee)) return imports.functions.has(identifierName(callee));
  return (
    callee.name.text === SHAPE_GUARD && imports.namespaces.has(identifierName(callee.expression))
  );
}

/** Appends to `walk.found` every shape guard in `node`, which runs in `scope` once every gate of `gates` is true. */
function collectGuards(
  node: Node,
  walk: GuardWalk,
  scope: Scope | undefined,
  gates: readonly Gate[],
): void {
  if (isBinaryExpression(node) && node.operatorToken.kind === SyntaxKind.AmpersandAmpersandToken) {
    collectGuards(node.left, walk, scope, gates);
    const name = identifierName(node.left);
    const rightGates = name === "" ? gates : [...gates, { name, local: binds(scope, name) }];
    collectGuards(node.right, walk, scope, rightGates);
    return;
  }
  if (callsGuard(node, walk.imports)) walk.found.push({ call: node, gates });
  const inner = enter(scope, node);
  node.forEachChild((child) => {
    collectGuards(child, walk, inner, gates);
  });
}

/** How `guard` can run while the file's `DEBUG` copy, named `copy`, is false; `undefined` when a gate reads the copy. */
function guardProblem(guard: Guard, copy: string | undefined): string | undefined {
  if (guard.gates.some((gate) => gate.name === copy && !gate.local)) return undefined;
  if (guard.gates.length === 0) return "the shape guard runs without a DEBUG gate";
  const names = guard.gates.map((gate) =>
    gate.local ? `${gate.name} (a local binding)` : gate.name,
  );
  return `the shape guard is gated by ${names.join(", ")}, not by the file's DEBUG copy`;
}

/** Every child node of `node`, in order. */
function children(node: Node): Node[] {
  const all: Node[] = [];
  node.forEachChild((child) => {
    all.push(child);
  });
  return all;
}

/** The text of an identifier or literal node, and `""` for any other node. */
function leafText(node: Node): string {
  return isIdentifier(node) || isLiteralExpression(node) || isLiteralLikeNode(node)
    ? node.text
    : "";
}

/** The operator of a prefix or postfix unary expression, which is no child node. */
function unaryOperator(node: Node): SyntaxKind | undefined {
  return isPrefixUnaryExpression(node) || isPostfixUnaryExpression(node)
    ? node.operator
    : undefined;
}

/** Whether `a` and `b` are the same expression: the same kinds, texts, and operators, child by child. */
function sameTree(a: Node, b: Node): boolean {
  if (a.kind !== b.kind || leafText(a) !== leafText(b) || unaryOperator(a) !== unaryOperator(b)) {
    return false;
  }
  const aChildren = children(a);
  const bChildren = children(b);
  return (
    aChildren.length === bChildren.length &&
    aChildren.every((child, i) => {
      const other = bChildren[i];
      return other !== undefined && sameTree(child, other);
    })
  );
}

/** The number of shape guards in `file`, the output named `name`, and every problem with them or its `DEBUG` copy. */
function fileProblems(
  name: string,
  file: SourceFile,
  runtime: Expression,
): { guards: number; problems: string[] } {
  const found: Guard[] = [];
  collectGuards(file, { imports: internalImports(file), found }, undefined, []);
  const copy = debugCopyOf(file);
  const problems: string[] = [];
  for (const guard of found) {
    const problem = guardProblem(guard, copy?.name);
    if (problem === undefined) continue;
    const { line } = file.getLineAndCharacterOfPosition(guard.call.getStart(file));
    problems.push(`${name}:${line + 1}: ${problem}`);
  }
  if (copy !== undefined && !sameTree(copy.initializer, runtime)) {
    problems.push(
      `${name}: the DEBUG copy ${copy.name} is initialized to ${copy.initializer.getText(file)}, ` +
        "not as src/ecstatic/debug.ts initializes DEBUG",
    );
  }
  return { guards: found.length, problems };
}

/**
 * Every problem with the shape guards of `outputs`: each guard that can run while its file's
 * `DEBUG` copy is false, and each copy initialized otherwise than `runtime`.
 *
 * @param outputs - Rewritten modules keyed by slash-separated path from the repository root; those
 *   under `src/` are left out.
 * @param runtime - The initializer of `DEBUG` in `src/ecstatic/debug.ts`.
 * @returns The problems in file name order, then {@link NO_GUARDS} when no module left in holds a
 *   shape guard.
 */
export function unstrippedProblems(
  outputs: ReadonlyMap<string, SourceFile>,
  runtime: Expression,
): string[] {
  const problems: string[] = [];
  let guards = 0;
  for (const name of [...outputs.keys()].toSorted()) {
    const file = outputs.get(name);
    if (file === undefined || name.startsWith("src/")) continue;
    const found = fileProblems(name, file, runtime);
    guards += found.guards;
    problems.push(...found.problems);
  }
  if (guards === 0) problems.push(NO_GUARDS);
  return problems;
}

/**
 * The initializer of the top-level `const DEBUG` of `file`, a parsed `src/ecstatic/debug.ts`.
 *
 * @param file - The parsed debug module.
 * @returns The initializer expression.
 * @throws Error naming the file when it declares no top-level `const DEBUG` with an initializer.
 */
export function runtimeDebug(file: SourceFile): Expression {
  for (const statement of file.statements) {
    const declared = soleConst(statement);
    if (declared?.name === "DEBUG") return declared.initializer;
  }
  throw new Error(`${file.fileName} declares no top-level const DEBUG with an initializer`);
}
