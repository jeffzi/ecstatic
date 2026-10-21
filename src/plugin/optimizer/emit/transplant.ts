/**
 * The transplant of a callback body: the statements that behave differently once the body runs as
 * the row loop's body instead of as the callback `eachStorageMatched` (`src/ecstatic/entity/each.ts`)
 * calls once per row, and the rules the body applies by what its own code uses and declares.
 *
 * Those statements are the callback's own returns, its own `var` declarations, and its own labels
 * that a statement enclosing the call also declares.
 */

import {
  type BindingElement,
  type BindingName,
  type Block,
  type CallExpression,
  type Expression,
  type ForInitializer,
  type Identifier,
  type Node,
  type ObjectLiteralElementLike,
  type PropertyName,
  type ReturnStatement,
  type Statement,
  SyntaxKind,
  type VariableDeclarationList,
} from "typescript/ast";
import {
  createArrayLiteralExpression,
  createBlock,
  createBreakStatement,
  createContinueStatement,
  createExpressionStatement,
  createIdentifier,
  createLabeledStatement,
  createObjectLiteralExpression,
  createOmittedExpression,
  createPropertyAssignment,
  createShorthandPropertyAssignment,
  createSpreadAssignment,
  createSpreadElement,
  createToken,
  updateBlock,
  updateCaseClause,
  updateDefaultClause,
  updateForInStatement,
  updateForOfStatement,
  updateForStatement,
} from "typescript/ast/factory";
import {
  isBlock,
  isBreakStatement,
  isCaseClause,
  isContinueStatement,
  isDefaultClause,
  isExpression,
  isForInStatement,
  isForOfStatement,
  isForStatement,
  isFunctionDeclaration,
  isFunctionLikeDeclaration,
  isIdentifier,
  isLabeledStatement,
  isPropertyName,
  isReturnStatement,
  isSourceFile,
  isStatement,
  isTryStatement,
  isVariableDeclaration,
  isVariableDeclarationList,
  isVariableStatement,
} from "typescript/ast/is";
import { visitNode } from "typescript/ast/visitor";

import type { NodeTable } from "../nodes.js";
import type { EachInlining } from "../plan.js";
import { boundNames } from "../syntax.js";
import { bodyRule, inDeadZone, inOwnCode, isCodeBoundary, outerReferences } from "./body-rules.js";
import type { Rule } from "./catalog.js";
import {
  assignTo,
  binary,
  declaration,
  letStatement,
  parenthesized,
  type Visit,
} from "./expressions.js";
import { tableNode } from "./lowering.js";
import type { NameGenerator } from "./names.js";

/**
 * The expressions whose text starts with their first child: an expression statement of one reads
 * as a block or a function declaration when that child, followed down, does.
 */
const LEADING_CHILD_KINDS: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.PostfixUnaryExpression,
  SyntaxKind.BinaryExpression,
  SyntaxKind.ConditionalExpression,
  SyntaxKind.TaggedTemplateExpression,
  SyntaxKind.CallExpression,
  SyntaxKind.AsExpression,
  SyntaxKind.ElementAccessExpression,
  SyntaxKind.PropertyAccessExpression,
  SyntaxKind.NonNullExpression,
  SyntaxKind.PartiallyEmittedExpression,
  SyntaxKind.SatisfiesExpression,
]);

/**
 * The rule a returned value applies by the kind of the expression its text starts with: the kinds
 * an expression statement must parenthesize.
 */
const RETURN_RULES: ReadonlyMap<SyntaxKind, Rule> = new Map([
  [SyntaxKind.ObjectLiteralExpression, "return-object-literal"],
  [SyntaxKind.FunctionExpression, "return-function-expression"],
]);

/** What a {@link Transplant} rewrites, and where it takes its names and records its rules. */
export interface TransplantParts {
  /** The node table of the file, which maps the inlining's node IDs. */
  readonly table: NodeTable;
  /** The inlining whose callback is transplanted. */
  readonly inlining: EachInlining;
  /** The inlined call. */
  readonly call: CallExpression;
  /** The body of the call's callback. */
  readonly body: Node;
  /** The generator of the loop's names, which the row loop's label and fresh labels come from. */
  readonly names: NameGenerator;
  /** The loop's applied rules, which the transplant adds to. */
  readonly applied: Set<Rule>;
}

/**
 * The rewrite of one callback's own returns, `var` declarations, and clashing labels, and the
 * record of the transplant rules its body applies.
 */
export class Transplant {
  /** Each return of the callback, mapped to whether an inner loop or switch lies above it. */
  readonly #returns = new Map<ReturnStatement, boolean>();
  /** The declaration list of every `var` statement and `for` head of the callback. */
  readonly #varLists = new Set<Node>();
  /** The names the `var` declarations bind, in the order they are first declared. */
  readonly #varNames: string[] = [];
  /**
   * Each labeled statement, break, and continue of the callback's own code whose label a statement
   * enclosing the call also declares, in the same function, mapped to the fresh label it takes:
   * once inlined, the two would be duplicate labels of one function.
   */
  readonly #relabeled = new Map<Node, string>();
  /** The blocks that stand for statements to splice into the enclosing statement list. */
  readonly #spliced = new WeakSet<Block>();
  readonly #applied: Set<Rule>;
  /** The row loop's label; undefined when no return needs one. */
  readonly #label: string | undefined;

  /**
   * @param parts - The callback's inlining and call, and the loop's names and rules.
   * @throws Error when a return or `var` declaration of the inlining is not in the node table.
   */
  constructor({ table, inlining, call, body, names, applied }: TransplantParts) {
    this.#applied = applied;
    const enclosing = enclosingLabels(call);
    if (enclosing.length > 0) this.#relabel(body, enclosing, names, new Map());
    if (inlining.varToLet.length > 0) applied.add("var-to-let");
    let nested = false;
    for (const ret of inlining.continues) {
      this.#returns.set(tableNode(table, ret.node, "return", isReturnStatement), ret.nested);
      nested ||= ret.nested;
    }
    this.#label = nested ? names.unique("row") : undefined;
    for (const id of inlining.varToLet) {
      const decl = tableNode(table, id, "var declaration", isVariableDeclaration);
      this.#varLists.add(decl.parent);
      for (const name of boundNames(decl.name)) {
        if (!this.#varNames.includes(name)) this.#varNames.push(name);
      }
    }
  }

  /**
   * The rewrite of `node` when it is a statement the transplant rewrites, or a statement list that
   * holds one.
   *
   * A return of the callback becomes `continue`, labeled with the row loop's label when it stands
   * under an inner loop or switch, after its value runs as a statement. A `var` statement becomes
   * the assignments of its initializers, and a `for` head's `var` list its assignments or, in a
   * `for…in` or `for…of` head, its one assignment target. A relabeled statement, break, or
   * continue takes its fresh label. A return inside a function nested in the body is left as is.
   *
   * @param node - A node of the body.
   * @param visit - Visits the parts of `node` the rewrite keeps.
   * @returns The rewrite, or undefined when the transplant leaves `node` to the caller.
   * @throws Error when an object pattern element of a `var` binding name has no key and binds no name.
   */
  visit(node: Node, visit: Visit): Node | undefined {
    const label = this.#relabeled.get(node);
    if (label !== undefined) return this.#withLabel(node, label, visit);
    if (isReturnStatement(node)) return this.#return(node, visit);
    if (isBlock(node)) return updateBlock(node, this.statements(node.statements, visit));
    if (isCaseClause(node) || isDefaultClause(node)) {
      const statements = this.statements(node.statements, visit);
      return isCaseClause(node)
        ? updateCaseClause(node, visitNode(node.expression, visit, isExpression), statements)
        : updateDefaultClause(node, node.expression, statements);
    }
    if (isVariableStatement(node) && this.#varLists.has(node.declarationList)) {
      const assignments = this.#assignments(node.declarationList, visit);
      return this.#statement(assignments === undefined ? [] : [expressionStatement(assignments)]);
    }
    return this.#forHead(node, visit);
  }

  /**
   * Visits a statement list of the body.
   *
   * @param statements - The statements.
   * @param visit - Visits each statement.
   * @returns The visited statements, with each rewrite that stands for several statements, or
   *   none, spliced in its place.
   */
  statements(statements: readonly Statement[], visit: Visit): Statement[] {
    return statements.flatMap((statement) => {
      const visited = visitNode(statement, visit, isStatement);
      return isBlock(visited) && this.#spliced.has(visited) ? [...visited.statements] : [visited];
    });
  }

  /**
   * The `let` statement that declares, once per row, every name the `var` declarations bind but a
   * function declaration at the root of the callback's body does not. In the callback, such a `var`
   * and function are one binding, which the function declaration alone still declares in the row's
   * block, where a `let` of the same name would not compile.
   *
   * @param body - The statements of the callback's block body.
   * @returns The statement, or undefined when no name is left.
   */
  bindings(body: readonly Statement[]): Statement | undefined {
    const functions = new Set<string | undefined>();
    for (const statement of body) {
      if (isFunctionDeclaration(statement)) functions.add(statement.name?.text);
    }
    const names = this.#varNames.filter((name) => !functions.has(name));
    if (names.length === 0) return undefined;
    return letStatement(names.map((name) => declaration(name)));
  }

  /**
   * The row loop under its label.
   *
   * @param loop - The row loop.
   * @returns `loop` under the row loop's label, or `loop` itself when no return needs the label.
   */
  labeled(loop: Statement): Statement {
    return this.#label === undefined
      ? loop
      : createLabeledStatement(createIdentifier(this.#label), loop);
  }

  /**
   * Records the transplant rule a node of the body, moved as written, applies as the callback's
   * own code.
   *
   * @param node - A node of the body.
   * @param callback - The callback.
   */
  noteBodyRule(node: Node, callback: Node): void {
    const rule = bodyRule(node);
    if (rule !== undefined && inOwnCode(node, callback, rule)) this.#applied.add(rule);
  }

  /**
   * Records the rules of the references in `callback` to bindings outside it: one named like a
   * binding the loop adds, which the loop's generated names avoid, and a read of an outer `let`,
   * `const`, or class still in its dead zone, which still throws where the callback would.
   *
   * @param call - The inlined call.
   * @param callback - Its callback.
   * @param added - The base names of the bindings the loop adds.
   */
  noteOuterReferences(call: CallExpression, callback: Node, added: readonly string[]): void {
    for (const reference of outerReferences(callback)) {
      if (added.includes(reference.text)) this.#applied.add("outer-binding");
      if (
        inOwnCode(reference, callback, "outer-let-dead-zone") &&
        inDeadZone(reference.text, call)
      ) {
        this.#applied.add("outer-let-dead-zone");
      }
    }
  }

  /**
   * Gives every labeled statement, break, and continue in `node`, the callback's own code, whose
   * label is one of `enclosing` a fresh label, the same one for every use of a name. A function or
   * class static block in `node` keeps its labels.
   *
   * @param node - A node of the callback's own code.
   * @param enclosing - The labels of the statements enclosing the call.
   * @param names - The generator the fresh labels come from.
   * @param fresh - The fresh label taken for each enclosing label so far.
   */
  #relabel(
    node: Node,
    enclosing: readonly string[],
    names: NameGenerator,
    fresh: Map<string, string>,
  ): void {
    if (isCodeBoundary(node)) return;
    const label = statementLabel(node);
    if (label !== undefined && enclosing.includes(label)) {
      const name = fresh.get(label) ?? names.unique(label);
      fresh.set(label, name);
      this.#relabeled.set(node, name);
    }
    node.forEachChild((child) => {
      this.#relabel(child, enclosing, names, fresh);
    });
  }

  /**
   * A labeled statement, break, or continue under a fresh label.
   *
   * @param node - The statement.
   * @param label - The fresh label.
   * @param visit - Visits a labeled statement's body.
   * @returns The statement under `label`.
   */
  #withLabel(node: Node, label: string, visit: Visit): Node {
    this.#applied.add("user-label-renamed");
    const id = createIdentifier(label);
    if (isLabeledStatement(node)) {
      return createLabeledStatement(id, visitNode(node.statement, visit, isStatement));
    }
    return isBreakStatement(node) ? createBreakStatement(id) : createContinueStatement(id);
  }

  /**
   * The rewrite of a return.
   *
   * @param node - A return of the body.
   * @param visit - Visits the returned value.
   * @returns `continue`, after the value runs, for a return of the callback; undefined for a return
   *   of a function nested in the body, which is left as is.
   */
  #return(node: ReturnStatement, visit: Visit): Node | undefined {
    const nested = this.#returns.get(node);
    if (nested === undefined) {
      this.#applied.add("return-in-nested-function");
      return undefined;
    }
    this.#noteReturn(node, nested);
    const label = nested ? this.#label : undefined;
    const next = createContinueStatement(label === undefined ? undefined : createIdentifier(label));
    if (node.expression === undefined) return next;
    const value = visitNode(node.expression, visit, isExpression);
    return this.#statement([expressionStatement(value), next]);
  }

  /**
   * Records the rules of a return of the callback: without a value, or with one that starts with
   * an object literal, a function expression, or anything else; the labeled continue; and a return
   * inside `try … finally`.
   *
   * @param node - The return.
   * @param nested - Whether an inner loop or switch lies above it.
   */
  #noteReturn(node: ReturnStatement, nested: boolean): void {
    const { expression } = node;
    if (expression === undefined) this.#applied.add("return-void");
    else this.#applied.add(RETURN_RULES.get(leftmostExpression(expression).kind) ?? "return-value");
    if (nested) this.#applied.add("return-labeled");
    for (let parent = node.parent; !isFunctionLikeDeclaration(parent); parent = parent.parent) {
      if (isTryStatement(parent) && parent.finallyBlock !== undefined) {
        this.#applied.add("return-in-finally");
        return;
      }
    }
  }

  /**
   * Statements that stand where one statement stood.
   *
   * @param statements - The statements.
   * @returns The one statement, or a block the enclosing statement list splices in place, which
   *   stays a block where a single statement must stand.
   */
  #statement(statements: readonly Statement[]): Statement {
    const [only] = statements;
    if (statements.length === 1 && only !== undefined) return only;
    const block = createBlock(statements, true);
    this.#spliced.add(block);
    return block;
  }

  /**
   * The rewrite of a `for`, `for…in`, or `for…of` statement whose head is a `var` list of the
   * callback.
   *
   * @param node - A node of the body.
   * @param visit - Visits the parts the rewrite keeps.
   * @returns The statement with the head's assignments, or its assignment target, in place of the
   *   list; undefined for any other node.
   * @throws Error when an object pattern element of a `var` binding name has no key and binds no name.
   */
  #forHead(node: Node, visit: Visit): Node | undefined {
    if (!isForStatement(node) && !isForInStatement(node) && !isForOfStatement(node)) {
      return undefined;
    }
    const { initializer } = node;
    if (!this.#isVarList(initializer)) return undefined;
    const statement = visitNode(node.statement, visit, isStatement);
    if (isForStatement(node)) {
      return updateForStatement(
        node,
        this.#assignments(initializer, visit),
        visitNode(node.condition, visit, isExpression),
        visitNode(node.incrementor, visit, isExpression),
        statement,
      );
    }
    const target = commaList(
      initializer.declarations.map((decl) => this.#target(decl.name, visit)),
    );
    const expression = visitNode(node.expression, visit, isExpression);
    return isForInStatement(node)
      ? updateForInStatement(node, node.awaitModifier, target, expression, statement)
      : updateForOfStatement(node, node.awaitModifier, target, expression, statement);
  }

  /**
   * Whether a `for` head is a `var` list of the callback.
   *
   * @param initializer - The head.
   * @returns Whether `initializer` is one of the callback's `var` lists.
   */
  #isVarList(initializer: ForInitializer | undefined): initializer is VariableDeclarationList {
    return (
      initializer !== undefined &&
      isVariableDeclarationList(initializer) &&
      this.#varLists.has(initializer)
    );
  }

  /**
   * The assignments of a `var` list.
   *
   * @param list - The list.
   * @param visit - Visits the initializers and the targets' defaults and computed keys.
   * @returns The comma list assigning each declaration of `list` that has an initializer, in
   *   order; undefined when none has.
   * @throws Error when an object pattern element of a `var` binding name has no key and binds no name.
   */
  #assignments(list: VariableDeclarationList, visit: Visit): Expression | undefined {
    const assigned: Expression[] = [];
    for (const decl of list.declarations) {
      if (decl.initializer === undefined) continue;
      const value = visitNode(decl.initializer, visit, isExpression);
      assigned.push(assignTo(this.#target(decl.name, visit), value));
    }
    return assigned.length === 0 ? undefined : commaList(assigned);
  }

  /**
   * The assignment target that binds the same names as a `var` declaration's binding name, in the
   * same order: a binding pattern becomes the object or array literal of the same shape.
   *
   * @param name - The binding name.
   * @param visit - Visits the pattern's defaults and computed keys.
   * @returns The target.
   * @throws Error when an object pattern element of a `var` binding name has no key and binds no name.
   */
  #target(name: BindingName, visit: Visit): Expression {
    if (isIdentifier(name)) return name;
    const { elements } = name;
    if (name.kind === SyntaxKind.ObjectBindingPattern) {
      return createObjectLiteralExpression(
        elements.map((element) => this.#objectTarget(element, visit)),
        false,
      );
    }
    return createArrayLiteralExpression(
      elements.map((element) => this.#arrayTarget(element, visit)),
      false,
    );
  }

  /**
   * A binding element of an object pattern as the member of an object assignment pattern.
   *
   * @param element - The element.
   * @param visit - Visits its default and computed key.
   * @returns `...target`, `key: target = fallback`, or `name = fallback`.
   * @throws Error when `element` has no key and binds no name.
   */
  #objectTarget(element: BindingElement, visit: Visit): ObjectLiteralElementLike {
    const { name, propertyName } = element;
    if (propertyName !== undefined) {
      const key = visitNode(propertyName, visit, isPropertyName);
      return propertyAssignment(key, this.#arrayTarget(element, visit));
    }
    if (name === undefined || !isIdentifier(name)) {
      throw new Error("emit: an object pattern element without a key binds no name");
    }
    if (element.dotDotDotToken !== undefined) return createSpreadAssignment(name);
    return shorthandAssignment(name, this.#fallback(element, visit));
  }

  /**
   * A binding element of an array pattern as the element of an array assignment pattern.
   *
   * @param element - The element, or an elision.
   * @param visit - Visits its default.
   * @returns `...target`, `target = fallback`, or an elision.
   */
  #arrayTarget(element: BindingElement, visit: Visit): Expression {
    const { name } = element;
    if (name === undefined) return createOmittedExpression();
    if (element.dotDotDotToken !== undefined) return createSpreadElement(this.#target(name, visit));
    return withDefault(this.#target(name, visit), this.#fallback(element, visit));
  }

  /**
   * The default of a binding element.
   *
   * @param element - The element.
   * @param visit - Visits the default.
   * @returns The visited default, or undefined when `element` has none.
   */
  #fallback(element: BindingElement, visit: Visit): Expression | undefined {
    const { initializer } = element;
    return initializer === undefined ? undefined : visitNode(initializer, visit, isExpression);
  }
}

/**
 * `target = fallback`.
 *
 * @param target - The assignment target.
 * @param fallback - The default, if any.
 * @returns The defaulted target, or `target` alone when `fallback` is undefined.
 */
function withDefault(target: Expression, fallback: Expression | undefined): Expression {
  return fallback === undefined ? target : assignTo(target, fallback);
}

/**
 * `key: value` in an object literal or assignment pattern.
 *
 * @param key - The property name.
 * @param value - The value, or the assignment target.
 * @returns The property assignment.
 */
function propertyAssignment(key: PropertyName, value: Expression): ObjectLiteralElementLike {
  // @ts-expect-error -- the generated factory types the type annotation as required, though a property assignment never has one
  return createPropertyAssignment(undefined, key, undefined, undefined, value);
}

/**
 * `name` or `name = fallback` in an object assignment pattern.
 *
 * @param name - The name.
 * @param fallback - The default, if any.
 * @returns The shorthand property assignment.
 */
function shorthandAssignment(
  name: Identifier,
  fallback: Expression | undefined,
): ObjectLiteralElementLike {
  const equals = fallback === undefined ? undefined : createToken(SyntaxKind.EqualsToken);
  // @ts-expect-error -- the generated factory types the type annotation as required, though a property assignment never has one
  return createShorthandPropertyAssignment(undefined, name, undefined, undefined, equals, fallback);
}

/**
 * Expressions evaluated in order as one.
 *
 * @param expressions - The expressions, at least one.
 * @returns `first, ..., last`.
 */
function commaList(expressions: readonly Expression[]): Expression {
  return expressions.reduce((list, next) => binary(list, SyntaxKind.CommaToken, next));
}

/**
 * An expression run as a statement.
 *
 * @param expression - The expression.
 * @returns The statement, whose expression is parenthesized when its text would otherwise read as
 *   a block or a function declaration.
 */
function expressionStatement(expression: Expression): Statement {
  const reads = RETURN_RULES.has(leftmostExpression(expression).kind);
  return createExpressionStatement(reads ? parenthesized(expression) : expression);
}

/**
 * The labels of the statements enclosing a call, up to the function, class static block, or file
 * that holds it.
 *
 * @param call - The call.
 * @returns The labels, innermost first.
 */
function enclosingLabels(call: Node): string[] {
  const labels: string[] = [];
  for (let node = call.parent; !isSourceFile(node) && !isCodeBoundary(node); node = node.parent) {
    if (isLabeledStatement(node)) labels.push(node.label.text);
  }
  return labels;
}

/**
 * The label a labeled statement, break, or continue declares or targets.
 *
 * @param node - A node.
 * @returns The label's text; undefined for any other node, and for a break or continue without a
 *   label.
 */
function statementLabel(node: Node): string | undefined {
  if (isLabeledStatement(node)) return node.label.text;
  if (isBreakStatement(node) || isContinueStatement(node)) return node.label?.text;
  return undefined;
}

/**
 * The expression another's text starts with.
 *
 * @param expression - The expression.
 * @returns The innermost expression at the start of `expression`'s text.
 */
function leftmostExpression(expression: Expression): Node {
  let inner: Node = expression;
  while (LEADING_CHILD_KINDS.has(inner.kind)) {
    const first: Node | undefined = inner.forEachChild((child) => child);
    if (first === undefined) break;
    inner = first;
  }
  return inner;
}
