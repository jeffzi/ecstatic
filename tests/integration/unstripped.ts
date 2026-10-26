/** Finds the debug guards in rewritten modules that can run while the runtime's `DEBUG` is false. */
import {
  type BinaryExpression,
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

/** The module the emitter imports the guards' namespace from. */
const INTERNAL_ENTRY = "ecstatic/internal";

/** What problems call the guard on `assertShape`. */
const SHAPE_LABEL = "shape guard";

/** What problems call the guard on `assertFilterMember`. */
const FILTER_LABEL = "filter-element guard";

/** The problem reported when no module holds a guard labeled `label`, so that the check cannot pass vacuously. */
function nothingToCheck(label: string): string {
  return `no test module's output holds a ${label}, so the check has nothing to check`;
}

/** The problem reported when no module holds a shape guard, so that the check cannot pass vacuously. */
export const NO_GUARDS = nothingToCheck(SHAPE_LABEL);

/** The problem reported when no module holds a filter-element guard, so that the check cannot pass vacuously. */
export const NO_FILTER_GUARDS = nothingToCheck(FILTER_LABEL);

/** A guard the emitter writes under the debug gate. */
interface GuardKind {
  /** The export of {@link INTERNAL_ENTRY} the guard calls. */
  readonly name: string;
  /** What problems call the guard. */
  readonly label: string;
}

/** Every guard the scan checks, keyed by the export of {@link INTERNAL_ENTRY} it calls. */
const GUARD_KINDS: ReadonlyMap<string, GuardKind> = new Map(
  [
    { name: "assertShape", label: SHAPE_LABEL },
    { name: "assertFilterMember", label: FILTER_LABEL },
  ].map((kind) => [kind.name, kind]),
);

/** An expression an `&&` expression requires to be true before its right operand runs. */
interface Gate {
  /** The expression, inside any parentheses. */
  readonly expression: Expression;
  /** The identifiers the expression reads that the file binds, at its top level or in a scope around the guard. */
  readonly bound: readonly string[];
}

/** One guard call, what it guards, and the gates around it, outermost first. */
interface Guard {
  readonly call: Node;
  readonly kind: GuardKind;
  readonly gates: readonly Gate[];
}

/** The local names through which a file calls the guards of {@link INTERNAL_ENTRY}: namespaces, and functions with the guard each calls. */
interface GuardImports {
  readonly namespaces: ReadonlySet<string>;
  readonly functions: ReadonlyMap<string, GuardKind>;
}

/** What {@link collectGuards} reads and gathers while it walks one file. */
interface GuardWalk {
  readonly imports: GuardImports;
  readonly found: Guard[];
}

/** The names the file's top level, a function, block, catch clause, class, or for statement binds, inside the scopes around it. */
interface Scope {
  readonly outer: Scope | undefined;
  readonly names: ReadonlySet<string>;
}

/** Whether `scope`, or a scope around it, binds `name`. */
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

/** Adds to `names` every name the imports among `statements` bind, types included. */
function importBindings(statements: readonly Statement[], names: Set<string>): void {
  for (const statement of statements) {
    if (!isImportDeclaration(statement)) continue;
    const clause = statement.importClause;
    if (clause === undefined) continue;
    if (clause.name !== undefined) names.add(clause.name.text);
    const bindings = clause.namedBindings;
    if (bindings === undefined) continue;
    if (isNamespaceImport(bindings)) names.add(bindings.name.text);
    else for (const specifier of bindings.elements) names.add(specifier.name.text);
  }
}

/** The scope of the top level of `file`: every name its statements and imports bind there. */
function fileScope(file: SourceFile): Scope {
  const names = new Set<string>();
  lexicalBindings(file.statements, names);
  hoistedVars(file, names);
  importBindings(file.statements, names);
  return { outer: undefined, names };
}

/** Every local name through which `file` can call a guard of {@link INTERNAL_ENTRY}. */
function internalImports(file: SourceFile): GuardImports {
  const namespaces = new Set<string>();
  const functions = new Map<string, GuardKind>();
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

/** Adds to `names` every local name `imports` gives a guard as a value, with the guard it calls. */
function guardFunctionNames(imports: NamedImports, names: Map<string, GuardKind>): void {
  for (const specifier of imports.elements) {
    const kind = GUARD_KINDS.get((specifier.propertyName ?? specifier.name).text);
    if (!specifier.isTypeOnly && kind !== undefined) names.set(specifier.name.text, kind);
  }
}

/** `expression` inside any parentheses. */
function unparenthesized(expression: Expression): Expression {
  let inner = expression;
  while (isParenthesizedExpression(inner)) inner = inner.expression;
  return inner;
}

/** The text of `node`, inside any parentheses, when it is an identifier, and `""` otherwise. */
function identifierName(node: Expression): string {
  const inner = unparenthesized(node);
  return isIdentifier(inner) ? inner.text : "";
}

/** Whether `node` is an `&&` expression. */
function isAnd(node: Node): node is BinaryExpression {
  return isBinaryExpression(node) && node.operatorToken.kind === SyntaxKind.AmpersandAmpersandToken;
}

/** The operands that must all be true for `expression` to be, inside any parentheses: those of an `&&` chain, or the expression itself. */
function conjuncts(expression: Expression): Expression[] {
  const inner = unparenthesized(expression);
  return isAnd(inner) ? [...conjuncts(inner.left), ...conjuncts(inner.right)] : [inner];
}

/** Adds to `names` every identifier `node` reads, leaving out the names of property accesses. */
function readNames(node: Node, names: Set<string>): void {
  if (isIdentifier(node)) {
    names.add(node.text);
  } else if (isPropertyAccessExpression(node)) {
    readNames(node.expression, names);
  } else {
    node.forEachChild((child) => {
      readNames(child, names);
    });
  }
}

/** `expression` as a gate of code that runs in `scope`. */
function gateOf(expression: Expression, scope: Scope | undefined): Gate {
  const names = new Set<string>();
  readNames(expression, names);
  return { expression, bound: [...names].filter((name) => binds(scope, name)) };
}

/** The guard `node` calls through one of `imports`, or `undefined` when it calls none. */
function calledGuard(node: Node, imports: GuardImports): GuardKind | undefined {
  if (!isCallExpression(node)) return undefined;
  const callee = node.expression;
  if (!isPropertyAccessExpression(callee)) return imports.functions.get(identifierName(callee));
  return imports.namespaces.has(identifierName(callee.expression))
    ? GUARD_KINDS.get(callee.name.text)
    : undefined;
}

/** Appends to `walk.found` every guard in `node`, which runs in `scope` once every gate of `gates` is true. */
function collectGuards(
  node: Node,
  walk: GuardWalk,
  scope: Scope | undefined,
  gates: readonly Gate[],
): void {
  if (isAnd(node)) {
    collectGuards(node.left, walk, scope, gates);
    const leftGates = conjuncts(node.left).map((operand) => gateOf(operand, scope));
    collectGuards(node.right, walk, scope, [...gates, ...leftGates]);
    return;
  }
  const kind = calledGuard(node, walk.imports);
  if (kind !== undefined) walk.found.push({ call: node, kind, gates });
  const inner = enter(scope, node);
  node.forEachChild((child) => {
    collectGuards(child, walk, inner, gates);
  });
}

/**
 * How `guard`, in `file`, can run while `runtime` is false.
 *
 * @param guard - The guard and its gates.
 * @param file - The parsed module holding the guard.
 * @param runtime - The initializer of `DEBUG` in `src/ecstatic/debug.ts`.
 * @returns The problem, or `undefined` when a gate is `runtime` reading no binding of the file. A
 *   gate that is `runtime` but reads a binding of the file is named with the names it reads there.
 */
function guardProblem(guard: Guard, file: SourceFile, runtime: Expression): string | undefined {
  const { gates, kind } = guard;
  if (gates.some((gate) => gate.bound.length === 0 && sameTree(gate.expression, runtime))) {
    return undefined;
  }
  if (gates.length === 0) return `the ${kind.label} runs without a DEBUG gate`;
  const texts = gates.map(({ expression, bound }) => {
    const text = expression.getText(file);
    const shadowed = bound.length > 0 && sameTree(expression, runtime);
    return shadowed ? `${text} (reading the file's own ${bound.join(", ")})` : text;
  });
  return `the ${kind.label} is gated by ${texts.join(", ")}, not by the runtime's DEBUG initializer`;
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

/** The guards `file`, the output named `name`, holds, and every problem with them. */
function fileProblems(
  name: string,
  file: SourceFile,
  runtime: Expression,
): { guards: readonly Guard[]; problems: string[] } {
  const found: Guard[] = [];
  collectGuards(file, { imports: internalImports(file), found }, fileScope(file), []);
  const problems: string[] = [];
  for (const guard of found) {
    const problem = guardProblem(guard, file, runtime);
    if (problem === undefined) continue;
    const { line } = file.getLineAndCharacterOfPosition(guard.call.getStart(file));
    problems.push(`${name}:${line + 1}: ${problem}`);
  }
  return { guards: found, problems };
}

/**
 * Every problem with the guards of `outputs`: each guard no gate of which is `runtime`, read where
 * no binding of its file shadows a name `runtime` reads.
 *
 * @param outputs - Rewritten modules keyed by slash-separated path from the repository root; those
 *   under `src/` are left out.
 * @param runtime - The initializer of `DEBUG` in `src/ecstatic/debug.ts`.
 * @returns The problems in file name order, then {@link NO_GUARDS} when no module left in holds a
 *   shape guard, and {@link NO_FILTER_GUARDS} when none holds a filter-element guard.
 */
export function unstrippedProblems(
  outputs: ReadonlyMap<string, SourceFile>,
  runtime: Expression,
): string[] {
  const problems: string[] = [];
  const held = new Set<GuardKind>();
  for (const name of [...outputs.keys()].toSorted()) {
    const file = outputs.get(name);
    if (file === undefined || name.startsWith("src/")) continue;
    const found = fileProblems(name, file, runtime);
    for (const guard of found.guards) held.add(guard.kind);
    problems.push(...found.problems);
  }
  for (const kind of GUARD_KINDS.values()) {
    if (!held.has(kind)) problems.push(nothingToCheck(kind.label));
  }
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
