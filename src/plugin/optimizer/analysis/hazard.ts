import {
  type BinaryExpression,
  type BindingElement,
  type CallExpression,
  type ElementAccessExpression,
  type Expression,
  type Node,
  type PostfixUnaryExpression,
  type PrefixUnaryExpression,
  type PropertyAccessExpression,
  SyntaxKind,
} from "typescript/ast";
import {
  isBinaryExpression,
  isBindingElement,
  isCallExpression,
  isComputedPropertyName,
  isElementAccessExpression,
  isIdentifier,
  isObjectBindingPattern,
  isPostfixUnaryExpression,
  isPrefixUnaryExpression,
  isPropertyAccessExpression,
  isTemplateSpan,
  isTokenKind,
  isVariableDeclarationList,
} from "typescript/ast/is";

import { type Checker, type CheckerSymbol, isGlobalValue, typeAtLocation } from "../compiler.js";
import { type ArchShape, type Op, shapeKey } from "../facts.js";
import {
  declarationKind,
  type InlineCallback,
  isThisParameter,
  skipErased,
  skipWrappers,
} from "../syntax.js";
import { forEachEvaluated } from "./evaluated.js";
import {
  isDestructuringAssignment,
  isViewReference,
  literalElementKey,
  patternKey,
} from "./roles.js";
import { type PackageRoots, recognize } from "./roots.js";
import { resolveStorageShape } from "./shape.js";
import {
  anyReadRuns,
  cloneSafe,
  dataOnly,
  isNullishType,
  isPrimitiveType,
  typeReadRuns,
} from "./type-reads.js";
import { viewKey } from "./view-key.js";

/** What hazard classification knows about the call whose callback it walks. */
export interface HazardScope {
  readonly checker: Checker;
  readonly roots: PackageRoots;
  /** The shapes the call iterates; a spawn into a storage of one of them is a hazard. */
  readonly shapes: readonly ArchShape[];
  /** The symbol of the callback's view parameter; undefined when it binds none. */
  readonly view: CheckerSymbol | undefined;
}

/** A `spawn` or `spawnMany` call accepted as hazard-free because it adds to another shape. */
export interface AcceptedSpawn {
  /** The call's storage argument. */
  readonly target: Expression;
  /** The shape-guard key of the shape the target's static type claims. */
  readonly key: string;
}

/** The hazard points of a callback. */
export interface Hazards {
  /** In source order, every node the callback evaluates that can run user code. */
  readonly points: readonly Node[];
  /**
   * In source order of their targets, the spawns accepted as hazard-free whose target holds no
   * hazard point. The target's static type is all the acceptance rests on, so a cast can forge it.
   */
  readonly spawns: readonly AcceptedSpawn[];
  /** The declaration files spawn targets' shapes consulted, sorted and without duplicates. */
  readonly declarationFiles: readonly string[];
}

/**
 * Collects the hazard points of a callback by an allowlist: a node is safe only when it is listed
 * as one that cannot run user code, and every other node is a hazard point. User code can grow the
 * iterated storage, which replaces its arrays, so a single hazard point keeps the inlined loop from
 * holding any array across an access.
 *
 * The parameters, defaults included, and the body are walked; a nested function only for the
 * parts that run when it is created, such as a class's static initializers and computed names.
 *
 * @param scope - The call the callback belongs to.
 * @param fn - The callback.
 * @returns The hazard points, the accepted spawns, and the declaration files resolving spawn targets
 *   consulted.
 * @throws When a consulted declaration's source file is no longer available.
 */
export async function hazardPoints(scope: HazardScope, fn: InlineCallback): Promise<Hazards> {
  const walker = new HazardWalker(scope);
  const walked = [...fn.parameters.filter((param) => !isThisParameter(param)), fn.body];
  const found = await Promise.all(walked.map(async (node) => await walker.walk(node)));
  const points = found.flatMap((part) => part.points);
  const spawns = found
    .flatMap((part) => part.spawns)
    .filter(({ target }) => !points.some((point) => contains(target, point)));
  return { points, spawns, declarationFiles: [...walker.files].toSorted() };
}

/**
 * Kinds whose node runs no user code beyond what its children run: statements and control flow,
 * literals built from their elements, declarations, functions and classes (their bodies run only
 * when called), and type-only wrappers.
 */
const SAFE_KINDS: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.Block,
  SyntaxKind.VariableStatement,
  SyntaxKind.VariableDeclaration,
  SyntaxKind.ExpressionStatement,
  SyntaxKind.IfStatement,
  SyntaxKind.DoStatement,
  SyntaxKind.WhileStatement,
  SyntaxKind.ForStatement,
  SyntaxKind.ContinueStatement,
  SyntaxKind.BreakStatement,
  SyntaxKind.ReturnStatement,
  SyntaxKind.LabeledStatement,
  SyntaxKind.SwitchStatement,
  SyntaxKind.CaseBlock,
  SyntaxKind.CaseClause,
  SyntaxKind.DefaultClause,
  SyntaxKind.ThrowStatement,
  SyntaxKind.TryStatement,
  SyntaxKind.CatchClause,
  SyntaxKind.EmptyStatement,
  SyntaxKind.ParenthesizedExpression,
  SyntaxKind.ConditionalExpression,
  SyntaxKind.ArrayLiteralExpression,
  SyntaxKind.ObjectLiteralExpression,
  SyntaxKind.PropertyAssignment,
  SyntaxKind.ShorthandPropertyAssignment,
  SyntaxKind.TemplateExpression,
  SyntaxKind.ArrowFunction,
  SyntaxKind.FunctionExpression,
  SyntaxKind.FunctionDeclaration,
  SyntaxKind.ClassDeclaration,
  SyntaxKind.ClassExpression,
  SyntaxKind.HeritageClause,
  SyntaxKind.ExpressionWithTypeArguments,
  SyntaxKind.MethodDeclaration,
  SyntaxKind.GetAccessor,
  SyntaxKind.SetAccessor,
  SyntaxKind.Constructor,
  SyntaxKind.PropertyDeclaration,
  SyntaxKind.ClassStaticBlockDeclaration,
  SyntaxKind.ObjectBindingPattern,
  SyntaxKind.Parameter,
  SyntaxKind.AsExpression,
  SyntaxKind.SatisfiesExpression,
  SyntaxKind.NonNullExpression,
  SyntaxKind.TypeAssertionExpression,
  SyntaxKind.TypeOfExpression,
  SyntaxKind.VoidExpression,
  SyntaxKind.MetaProperty,
  SyntaxKind.InterfaceDeclaration,
  SyntaxKind.TypeAliasDeclaration,
]);

/**
 * Binary operators that convert no operand: assignment, the logical operators and their
 * assignments, the comma, and strict equality.
 */
const NON_CONVERTING_OPERATORS: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.AmpersandAmpersandToken,
  SyntaxKind.BarBarToken,
  SyntaxKind.QuestionQuestionToken,
  SyntaxKind.CommaToken,
  SyntaxKind.EqualsEqualsEqualsToken,
  SyntaxKind.ExclamationEqualsEqualsToken,
  SyntaxKind.AmpersandAmpersandEqualsToken,
  SyntaxKind.BarBarEqualsToken,
  SyntaxKind.QuestionQuestionEqualsToken,
]);

/** Binary operators that probe their right operand: `instanceof` and `in`. */
const PROBING_OPERATORS: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.InstanceOfKeyword,
  SyntaxKind.InKeyword,
]);

/** Loose equality operators, which compare against `null` or `undefined` without converting. */
const LOOSE_EQUALITY_OPERATORS: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.EqualsEqualsToken,
  SyntaxKind.ExclamationEqualsToken,
]);

/**
 * How an ecstatic op reads its arguments: from index `from` on, the properties of each argument, to
 * `depth` levels, or at every depth when `clone` is set, as `setResource`'s deep clone of its value
 * does.
 */
interface Reads {
  readonly from: number;
  readonly depth: number;
  readonly clone: boolean;
}

const READS_NOTHING: Reads = { from: 0, depth: 0, clone: false };

/**
 * How the ops on the allowlist read their object arguments. `register`, `destroyWorld`, and every
 * op not listed may replace a storage's arrays.
 */
const ARGUMENT_READS: ReadonlyMap<Op, Reads> = new Map<Op, Reads>([
  ["get", READS_NOTHING],
  ["has", READS_NOTHING],
  ["hasAny", READS_NOTHING],
  ["alive", READS_NOTHING],
  ["disable", READS_NOTHING],
  ["disableMany", READS_NOTHING],
  ["getTarget", READS_NOTHING],
  ["unlink", READS_NOTHING],
  ["getResource", READS_NOTHING],
  ["resetResource", READS_NOTHING],
  ["getSources", READS_NOTHING],
  ["hasSources", READS_NOTHING],
  ["countSources", READS_NOTHING],
  ["despawn", READS_NOTHING],
  ["despawnMany", READS_NOTHING],
  ["set", { from: 3, depth: 1, clone: false }],
  ["link", { from: 4, depth: 1, clone: false }],
  ["enable", { from: 2, depth: 2, clone: false }],
  ["enableMany", { from: 1, depth: 2, clone: false }],
  ["spawn", { from: 1, depth: 2, clone: false }],
  ["spawnMany", { from: 2, depth: 2, clone: false }],
  ["setResource", { from: 2, depth: 0, clone: true }],
]);

/** The ops whose first argument is the storage they add entities to. */
const SPAWNS: ReadonlySet<Op> = new Set<Op>(["spawn", "spawnMany"]);

/** A node read as a view use, whose operands are not classified. */
const VIEW_PART = "view-part";

/** What a walk found under a node, each list in source order. */
interface Found {
  readonly points: readonly Node[];
  readonly spawns: readonly AcceptedSpawn[];
}

/** A walk that found nothing. */
const NOTHING: Found = { points: [], spawns: [] };

class HazardWalker {
  readonly files = new Set<string>();
  /** The spawns accepted as hazard-free, keyed by their call. */
  readonly #spawns = new Map<Node, AcceptedSpawn>();
  readonly #scope: HazardScope;
  readonly #checker: Checker;

  constructor(scope: HazardScope) {
    this.#scope = scope;
    this.#checker = scope.checker;
  }

  /**
   * The hazard points and accepted spawns of a node and of the nodes it evaluates. A token (a
   * literal, an identifier, a keyword, or punctuation) runs nothing. The children are walked
   * alongside the node's own classification, so a file's queries are in flight together and finish
   * in no fixed order; a view part drops their result.
   *
   * @param node - The node to walk.
   * @returns The hazard points and the accepted spawns, each in source order.
   * @throws When a consulted declaration's source file is no longer available.
   */
  async walk(node: Node): Promise<Found> {
    if (isTokenKind(node.kind)) return NOTHING;
    const children: Promise<Found>[] = [];
    forEachEvaluated(node, (child) => {
      children.push(this.walk(child));
    });
    const [own, nested] = await Promise.all([this.#classify(node), Promise.all(children)]);
    if (own === VIEW_PART) return NOTHING;
    const spawn = this.#spawns.get(node);
    return {
      points: [...own, ...nested.flatMap((part) => part.points)],
      spawns: [...(spawn === undefined ? [] : [spawn]), ...nested.flatMap((part) => part.spawns)],
    };
  }

  /**
   * The hazard points a node records itself, before those of the nodes it evaluates. A view use
   * reads the storage's columns, which runs no user code, so its operands are not classified as
   * property reads.
   *
   * @param node - The node to classify; not a token.
   * @returns The points, or {@link VIEW_PART} when the node is part of a view use.
   * @throws When a consulted declaration's source file is no longer available.
   */
  async #classify(node: Node): Promise<Node[] | typeof VIEW_PART> {
    if (isPropertyAccessExpression(node) || isElementAccessExpression(node)) {
      const [viewPart, runs] = await Promise.all([this.#isViewPart(node), this.#accessRuns(node)]);
      if (viewPart) return VIEW_PART;
      return runs ? [node] : [];
    }
    const point = await this.#point(node);
    return point === undefined ? [] : [point];
  }

  /**
   * The hazard point a node other than an access records itself.
   *
   * @param node - The node to classify; not a token.
   * @returns The node recorded: `node` itself or the operand it converts, or undefined when it
   *   records none.
   * @throws When a consulted declaration's source file is no longer available.
   */
  async #point(node: Node): Promise<Node | undefined> {
    if (isCallExpression(node)) return unless(node, await this.#safeCall(node));
    if (isBinaryExpression(node)) return await this.#binaryPoint(node);
    if (isPrefixUnaryExpression(node) || isPostfixUnaryExpression(node)) {
      return await this.#unaryPoint(node);
    }
    if (isTemplateSpan(node) || isComputedPropertyName(node)) {
      // Converting an object to a string or a property key calls its toString or valueOf.
      return unless(node.expression, await this.#primitive(node.expression));
    }
    if (isBindingElement(node)) return unless(node, !(await this.#bindingReadRuns(node)));
    return unless(node, isSafeNode(node));
  }

  /**
   * The hazard point of a prefix or postfix unary expression: `!` converts nothing, and every other
   * operator converts its operand.
   *
   * @param node - The unary expression.
   * @returns `node`, or undefined when it records none.
   */
  async #unaryPoint(
    node: PrefixUnaryExpression | PostfixUnaryExpression,
  ): Promise<Node | undefined> {
    if (isPrefixUnaryExpression(node) && node.operator === SyntaxKind.ExclamationToken) {
      return undefined;
    }
    return unless(node, await this.#primitive(node.operand));
  }

  /**
   * Whether an access is `e.K` or `e.C.f` on the view, in the receiver forms the body walker reads
   * as view uses: through parentheses and non-null assertions, and with the view keys
   * {@link viewKey} reads.
   *
   * @param access - The access to test.
   * @returns Whether `access` is part of a view use.
   */
  async #isViewPart(access: PropertyAccessExpression | ElementAccessExpression): Promise<boolean> {
    const inner = skipWrappers(access.expression);
    const [key, field] = await Promise.all([
      this.#isViewKey(access),
      isPropertyAccessExpression(access) &&
      (isPropertyAccessExpression(inner) || isElementAccessExpression(inner))
        ? this.#isViewKey(inner)
        : false,
    ]);
    return key || field;
  }

  /**
   * Whether an access reads a view key, as {@link viewKey} decides it, of a receiver the checker
   * resolves to the view.
   *
   * @param access - The access to test.
   * @returns Whether `access` names a key of the view.
   * @throws When the compiler process has exited.
   */
  async #isViewKey(access: PropertyAccessExpression | ElementAccessExpression): Promise<boolean> {
    const { view, shapes } = this.#scope;
    const onView = await isViewReference(this.#checker, view, skipWrappers(access.expression));
    return viewKey(access, onView, shapes) !== undefined;
  }

  /**
   * Whether reading or writing through an access can run user code. A private name is not
   * resolved statically. An element access's key that is not primitive converts through its
   * toString or valueOf, and the property a key names can be an accessor of the receiver's type: a
   * literal key names one property, any other key can name every property.
   *
   * @param access - The access to test.
   * @returns Whether the access can run user code.
   */
  async #accessRuns(access: PropertyAccessExpression | ElementAccessExpression): Promise<boolean> {
    if (isPropertyAccessExpression(access)) {
      if (!isIdentifier(access.name)) return true;
      return await this.#readRuns(access.expression, access.name.text);
    }
    const name = literalElementKey(access);
    const [primitiveKey, runs] = await Promise.all([
      this.#primitive(access.argumentExpression),
      name === undefined
        ? this.#anyReadRuns(access.expression)
        : this.#readRuns(access.expression, name),
    ]);
    return !primitiveKey || runs;
  }

  /**
   * The hazard points of a binary expression: `in` and `instanceof` (a proxy trap,
   * `Symbol.hasInstance`), an array or object destructuring assignment (the iterator protocol, or
   * reads through getters), and an operator that converts an object operand to a primitive. Loose
   * equality with `null` or `undefined` compares without converting the other operand, so a
   * presence test of an optional slot, `e.C == null`, stays hazard-free.
   *
   * @param node - The binary expression.
   * @returns The node it records: itself or its assignment pattern, or undefined when it records
   *   none.
   */
  async #binaryPoint(node: BinaryExpression): Promise<Node | undefined> {
    const operator = node.operatorToken.kind;
    if (PROBING_OPERATORS.has(operator)) return node;
    if (operator === SyntaxKind.EqualsToken) {
      return isDestructuringAssignment(node) ? node.left : undefined;
    }
    if (NON_CONVERTING_OPERATORS.has(operator)) return undefined;
    return await this.#conversionPoint(node, LOOSE_EQUALITY_OPERATORS.has(operator));
  }

  /**
   * The hazard point of an operator that converts its operands.
   *
   * @param node - The binary expression.
   * @param loose - Whether the operator is `==` or `!=`, which compares a nullish operand without
   *   converting the other.
   * @returns `node`, or undefined when no operand converts through user code.
   */
  async #conversionPoint(node: BinaryExpression, loose: boolean): Promise<Node | undefined> {
    const [leftNullish, rightNullish, leftPrimitive, rightPrimitive] = await Promise.all([
      loose && this.#nullish(node.left),
      loose && this.#nullish(node.right),
      this.#primitive(node.left),
      this.#primitive(node.right),
    ]);
    if (leftNullish || rightNullish) return undefined;
    return unless(node, leftPrimitive && rightPrimitive);
  }

  /**
   * Whether an element of an object destructuring pattern can run user code as it reads its
   * property: a rest element reads every property, and a computed key is not known statically.
   *
   * @param element - The binding element.
   * @returns Whether reading the element's property can run user code.
   */
  async #bindingReadRuns(element: BindingElement): Promise<boolean> {
    const pattern = element.parent;
    if (!isObjectBindingPattern(pattern)) return false;
    if (element.dotDotDotToken !== undefined) return true;
    const key = patternKey(element);
    if (key === undefined) return true;
    return await typeReadRuns(this.#checker, await typeAtLocation(this.#checker, pattern), key);
  }

  /**
   * Whether a call is on the allowlist: a method of the global `Math` whose arguments are all
   * primitive, or an ecstatic op that never replaces the iterated storage's arrays and whose object
   * arguments cannot run a getter at the depth it reads them. `spawn` and `spawnMany` qualify only
   * into a storage whose shape key differs from every iterated one; such a spawn is recorded for
   * {@link HazardWalker.walk} to report.
   *
   * @param call - The call to test.
   * @returns Whether the call runs no user code.
   * @throws When a consulted declaration's source file is no longer available.
   */
  async #safeCall(call: CallExpression): Promise<boolean> {
    const callee = call.expression;
    const [math, recognized] = await Promise.all([
      isPropertyAccessExpression(callee) && isGlobalValue(this.#checker, callee.expression, "Math"),
      recognize(this.#checker, this.#scope.roots, call),
    ]);
    if (math) return await this.#primitiveArguments(call);
    const reads = recognized === undefined ? undefined : ARGUMENT_READS.get(recognized.op);
    if (recognized === undefined || reads === undefined) return false;
    return await this.#safeOp(call, reads, SPAWNS.has(recognized.op));
  }

  /**
   * Whether a call to an allowlisted ecstatic op runs no user code: no object argument can run a
   * getter at the depth the op reads it, and a spawn adds to another shape. An accepted spawn is
   * recorded for {@link HazardWalker.walk} to report.
   *
   * @param call - The op's call.
   * @param reads - How the op reads its object arguments.
   * @param isSpawn - Whether the op is `spawn` or `spawnMany`.
   * @returns Whether the call runs no user code.
   * @throws When a consulted declaration's source file is no longer available.
   */
  async #safeOp(call: CallExpression, reads: Reads, isSpawn: boolean): Promise<boolean> {
    const args = call.arguments;
    const [spawn, safe] = await Promise.all([
      isSpawn ? this.#elsewhereSpawn(args[0]) : undefined,
      Promise.all(args.slice(reads.from).map(async (arg) => await this.#argumentSafe(reads, arg))),
    ]);
    if (!safe.every(Boolean)) return false;
    if (!isSpawn) return true;
    if (spawn === undefined) return false;
    this.#spawns.set(call, spawn);
    return true;
  }

  /**
   * Whether every argument of a call is primitive. A `Math` method converts each argument to a
   * number, which runs an object's valueOf or toString.
   *
   * @param call - The call to test.
   * @returns Whether no argument can convert through user code.
   * @throws When the compiler process has exited.
   */
  async #primitiveArguments(call: CallExpression): Promise<boolean> {
    const primitive = await Promise.all(
      call.arguments.map(async (arg) => await this.#primitive(arg)),
    );
    return primitive.every(Boolean);
  }

  async #argumentSafe(reads: Reads, arg: Expression): Promise<boolean> {
    const type = await typeAtLocation(this.#checker, arg);
    if (reads.clone) return await cloneSafe(this.#checker, type, new Set());
    return await dataOnly(this.#checker, type, reads.depth);
  }

  /**
   * A spawn into a target that resolves to a shape whose key differs from that of every storage the
   * callback iterates. The declaration files its resolution consulted are recorded.
   *
   * @param storage - The spawn's storage argument.
   * @returns The target with its shape key, or undefined when the spawn can grow an iterated
   *   storage: the target is missing, its shape does not resolve, the call iterates no resolved
   *   shape, or the key matches an iterated one.
   * @throws When a consulted declaration's source file is no longer available.
   */
  async #elsewhereSpawn(storage: Expression | undefined): Promise<AcceptedSpawn | undefined> {
    if (storage === undefined) return undefined;
    const { shape, declarationFiles } = await resolveStorageShape(
      this.#checker,
      storage,
      this.#scope.roots,
    );
    for (const file of declarationFiles) this.files.add(file);
    const { shapes } = this.#scope;
    if (shape === undefined || shapes.length === 0) return undefined;
    const key = shapeKey(shape);
    return shapes.every((iterated) => shapeKey(iterated) !== key)
      ? { target: storage, key }
      : undefined;
  }

  async #readRuns(receiver: Expression, name: string): Promise<boolean> {
    return await typeReadRuns(this.#checker, await typeAtLocation(this.#checker, receiver), name);
  }

  async #anyReadRuns(receiver: Expression): Promise<boolean> {
    return await anyReadRuns(this.#checker, await typeAtLocation(this.#checker, receiver));
  }

  /**
   * Whether an expression's static type holds only primitives, which convert without running user
   * code. The type is read inside every erased wrapper, because an assertion such as
   * `x as unknown as number` hides an object, whose valueOf or toString still runs, behind a
   * primitive type.
   *
   * @param expr - The expression to test.
   * @returns Whether every value of `expr` is a primitive.
   * @throws When the compiler process has exited.
   */
  async #primitive(expr: Expression): Promise<boolean> {
    return await isPrimitiveType(await typeAtLocation(this.#checker, skipErased(expr)));
  }

  /**
   * Whether an expression's static type holds only `null` and `undefined`.
   *
   * @param expr - The expression to test.
   * @returns Whether `expr` is nullish.
   */
  async #nullish(expr: Expression): Promise<boolean> {
    return await isNullishType(await typeAtLocation(this.#checker, expr));
  }
}

/**
 * Whether a node of a kind with no classification of its own runs no user code.
 *
 * @param node - The node to test.
 * @returns Whether the node is on the allowlist; a `using` declaration list is not, since leaving
 *   its scope disposes the resource.
 */
function isSafeNode(node: Node): boolean {
  if (isVariableDeclarationList(node)) {
    const kind = declarationKind(node);
    return kind !== "using" && kind !== "await using";
  }
  return SAFE_KINDS.has(node.kind);
}

/**
 * Whether `inner` lies within `outer`'s text.
 *
 * @param outer - The enclosing node.
 * @param inner - The node to test.
 * @returns Whether `inner`'s range is inside `outer`'s.
 */
function contains(outer: Node, inner: Node): boolean {
  return inner.pos >= outer.pos && inner.end <= outer.end;
}

/**
 * The node a classification records.
 *
 * @param node - The node recorded when it can run user code.
 * @param safe - Whether it runs no user code.
 * @returns `node`, or undefined when `safe` is set.
 */
function unless(node: Node, safe: boolean): Node | undefined {
  return safe ? undefined : node;
}
