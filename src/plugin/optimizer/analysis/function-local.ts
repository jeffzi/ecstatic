import {
  type CallExpression,
  type FunctionDeclaration,
  type FunctionExpression,
  type Node,
  type ReturnStatement,
  SyntaxKind,
  type VariableDeclaration,
} from "typescript/ast";
import {
  isArrowFunction,
  isCallExpression,
  isClassStaticBlockDeclaration,
  isFunctionDeclaration,
  isFunctionExpression,
  isIdentifier,
  isMetaProperty,
  isPropertyDeclaration,
  isReturnStatement,
  isThisExpression,
  isVariableDeclarationList,
} from "typescript/ast/is";

import { type Checker, type CheckerSymbol, refersToArguments, resolveSymbol } from "../compiler.js";
import {
  declarationKind,
  type FunctionMember,
  type InlineCallback,
  isFunctionMember,
  isThisParameter,
  isTypeOnly,
  runsWithClass,
  skipErased,
  visitMemberHead,
} from "../syntax.js";
import { forEachEvaluated } from "./evaluated.js";

/** A `return` statement of a callback's own body. */
export interface OwnReturn {
  readonly node: ReturnStatement;
  /** Whether a loop or `switch` of the callback encloses the statement. */
  readonly nested: boolean;
}

/** Statements a `return` inside leaves along with the callback: loops and `switch`. */
const BREAKABLE_KINDS: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.ForStatement,
  SyntaxKind.ForInStatement,
  SyntaxKind.ForOfStatement,
  SyntaxKind.WhileStatement,
  SyntaxKind.DoStatement,
  SyntaxKind.SwitchStatement,
]);

const ARGUMENTS = "arguments";

/**
 * The callback's own `return` statements: those its body runs, none from a nested function.
 *
 * @param fn - The callback.
 * @returns The statements in source order.
 */
export function ownReturns(fn: InlineCallback): OwnReturn[] {
  const returns: OwnReturn[] = [];
  const walk = (node: Node, nested: boolean): void => {
    if (isReturnStatement(node)) returns.push({ node, nested });
    const inner = nested || BREAKABLE_KINDS.has(node.kind);
    forEachEvaluated(node, (child) => {
      walk(child, inner);
    });
  };
  walk(fn.body, false);
  return returns;
}

/**
 * The callback's own `var` declarations: those its body runs, none from a nested function or a
 * class static block, which scope their own.
 *
 * @param fn - The callback.
 * @returns The declarations in source order.
 */
export function ownVarDeclarations(fn: InlineCallback): VariableDeclaration[] {
  const declarations: VariableDeclaration[] = [];
  const walk = (node: Node): void => {
    if (isClassStaticBlockDeclaration(node)) return;
    if (isVariableDeclarationList(node) && declarationKind(node) === "var") {
      declarations.push(...node.declarations);
    }
    forEachEvaluated(node, walk);
  };
  walk(fn.body);
  return declarations;
}

/**
 * Every direct `eval` call in the callback, nested functions included.
 *
 * Strict code, which modules always are, cannot bind the name `eval`, so a plain call of it is
 * always the global's direct form. That holds through parentheses, which keep the reference, and
 * through the type wrappers the compiler erases. An optional call is indirect.
 *
 * @param fn - The callback.
 * @returns The calls in source order.
 */
export function directEvalCalls(fn: InlineCallback): CallExpression[] {
  const calls: CallExpression[] = [];
  const walk = (node: Node): void => {
    if (isDirectEval(node)) calls.push(node);
    node.forEachChild(walk);
  };
  fn.forEachChild(walk);
  return calls;
}

function isDirectEval(node: Node): node is CallExpression {
  if (!isCallExpression(node) || node.questionDotToken !== undefined) return false;
  const callee = skipErased(node.expression);
  return isIdentifier(callee) && callee.text === "eval";
}

/** What a recorded node reads, which decides how it is confirmed. */
type Reads = "binding" | "arguments" | "self";

interface Candidate {
  readonly node: Node;
  readonly reads: Reads;
}

/**
 * The uses of a function expression's own bindings: `this`, `arguments`, `new.target`, and its own
 * name.
 *
 * The walk covers all code nested in the callback, at any depth, because the callback's name
 * resolves to it wherever it sits. Nested arrow functions see the callback's `this`, `arguments`,
 * and `new.target`. Nested non-arrow functions, members, and instance field initializers bind
 * their own, as do a class's static blocks and static field initializers, so inside them only
 * references to the name count. A class's decorators, computed member names, and parameter
 * decorators run when the class is evaluated, inside the callback, so they see its bindings. A
 * nested binding that shadows the name resolves to its own symbol and never counts. Types are
 * erased, so a reference inside one, such as `typeof visit`, never counts.
 *
 * An arrow function has none of these bindings, so it has no uses.
 *
 * @param checker - Checker of the program holding `fn`.
 * @param fn - The callback.
 * @returns The uses in source order.
 */
export async function functionLocalUses(checker: Checker, fn: InlineCallback): Promise<Node[]> {
  if (isArrowFunction(fn)) return [];
  const collector = new CandidateCollector(fn.name?.text);
  for (const param of fn.parameters) {
    if (!isThisParameter(param)) collector.walk(param, true);
  }
  collector.walk(fn.body, true);
  // Only a candidate reading the name awaits its symbol, so the query starts only when one does: a
  // query nothing awaits would reject unhandled when the compiler process exits.
  const readsSelf = collector.candidates.some(({ reads }) => reads === "self");
  const self = fn.name !== undefined && readsSelf ? resolveSymbol(checker, fn.name) : undefined;
  const kept = await Promise.all(
    collector.candidates.map((candidate) => confirms(checker, candidate, self)),
  );
  return collector.candidates.filter((_, i) => kept[i] === true).map(({ node }) => node);
}

async function confirms(
  checker: Checker,
  { node, reads }: Candidate,
  self: Promise<CheckerSymbol | undefined> | undefined,
): Promise<boolean> {
  if (reads === "binding") return true;
  if (reads === "arguments") return await refersToArguments(checker, node);
  const [own, read] = await Promise.all([self, resolveSymbol(checker, node)]);
  return own !== undefined && own === read;
}

/** Collects the nodes that may use the callback's bindings, in source order. */
class CandidateCollector {
  readonly candidates: Candidate[] = [];
  readonly #selfName: string | undefined;

  constructor(selfName: string | undefined) {
    this.#selfName = selfName;
  }

  /**
   * Collects the candidates in `node` and its descendants.
   *
   * @param node - The node to walk.
   * @param ownThis - Whether the code around `node` sees the callback's `this`, `arguments`, and
   *   `new.target`; false inside code that binds its own.
   */
  walk(node: Node, ownThis: boolean): void {
    if (isTypeOnly(node) || this.#walkScope(node, ownThis) || this.#visitLeaf(node, ownThis)) {
      return;
    }
    node.forEachChild((child) => {
      this.walk(child, ownThis);
    });
  }

  /**
   * Walks a node that opens code binding its own `this`: a nested function, a member, or a static
   * block.
   *
   * @param node - The node to walk.
   * @param ownThis - Whether the code around `node` sees the callback's `this`.
   * @returns Whether `node` opens such code and was walked.
   */
  #walkScope(node: Node, ownThis: boolean): boolean {
    if (isFunctionDeclaration(node) || isFunctionExpression(node)) {
      this.#walkRun(node, false);
    } else if (isFunctionMember(node)) {
      visitMemberHead(node, (part) => {
        this.walk(part, ownThis);
      });
      this.#walkRun(node, ownThis);
    } else if (isPropertyDeclaration(node)) {
      visitMemberHead(node, (part) => {
        this.walk(part, ownThis);
      });
      if (node.initializer !== undefined) this.walk(node.initializer, false);
    } else if (isClassStaticBlockDeclaration(node)) {
      this.walk(node.body, false);
    } else {
      return false;
    }
    return true;
  }

  /**
   * Walks the parameters and body of a nested function or member, which bind their own `this`. A
   * parameter's decorators run with the class, so they see the enclosing `this`.
   *
   * @param fn - The nested function or member.
   * @param ownThis - Whether the member's decorators see the callback's `this`; false for a
   *   function, which has none.
   */
  #walkRun(fn: FunctionDeclaration | FunctionExpression | FunctionMember, ownThis: boolean): void {
    for (const param of fn.parameters) {
      param.forEachChild((child) => {
        this.walk(child, ownThis && runsWithClass(child));
      });
    }
    if (fn.body !== undefined) this.walk(fn.body, false);
  }

  /**
   * Records a `this`, `new.target`, or identifier that may use the callback's bindings.
   *
   * @param node - The node to test.
   * @param ownThis - Whether the code around `node` sees the callback's `this`.
   * @returns Whether `node` is such a leaf, where the walk stops.
   */
  #visitLeaf(node: Node, ownThis: boolean): boolean {
    let reads: Reads | undefined;
    if (isThisExpression(node)) {
      reads = ownThis ? "binding" : undefined;
    } else if (isMetaProperty(node)) {
      reads = ownThis && node.keywordToken === SyntaxKind.NewKeyword ? "binding" : undefined;
    } else if (isIdentifier(node)) {
      reads = this.#identifierReads(node.text, ownThis);
    } else {
      return false;
    }
    if (reads !== undefined) this.candidates.push({ node, reads });
    return true;
  }

  #identifierReads(text: string, ownThis: boolean): Reads | undefined {
    if (text === ARGUMENTS) return ownThis ? "arguments" : undefined;
    return text === this.#selfName ? "self" : undefined;
  }
}
