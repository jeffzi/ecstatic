import {
  type CallExpression,
  type Identifier,
  ModifierFlags,
  type Node,
  type ObjectBindingPattern,
  type ParameterDeclaration,
  type SourceFile,
} from "typescript/ast";
import {
  isArrowFunction,
  isBlock,
  isBindingElement,
  isCallExpression,
  isFunctionExpression,
  isFunctionLikeDeclaration,
  isIdentifier,
  isObjectBindingPattern,
  isVariableDeclaration,
} from "typescript/ast/is";

import { type Checker, type CheckerSymbol, isGlobalValue, resolveSymbol } from "../compiler.js";
import {
  addDeclarationFile,
  type ArchShape,
  type Callback,
  iterates,
  type Op,
  type ParamForm,
  type Site,
  type ViewEscape,
} from "../facts.js";
import type { NodeTable } from "../nodes.js";
import { nodePosition } from "../position.js";
import { boundNames, isThisParameter, isTypeOnly } from "../syntax.js";
import { forEachDeferred, forEachEvaluated, isNestedFunction } from "./evaluated.js";
import {
  directEvalCalls,
  functionLocalUses,
  type InlineCallback,
  ownReturns,
  ownVarDeclarations,
} from "./function-local.js";
import { type Hazards, hazardPoints } from "./hazard.js";
import { isNamePosition } from "./roles.js";
import { type PackageRoots, recognize } from "./roots.js";
import { type FoundEscape, ViewClassifier } from "./view-uses.js";

/** The file a callback belongs to, and what analyzing it reads and writes. */
export interface CallbackScope {
  readonly checker: Checker;
  readonly roots: PackageRoots;
  /** Registers the nodes the summary reports. */
  readonly table: NodeTable;
  readonly file: SourceFile;
}

/**
 * The function an iteration call passes inline as its last argument.
 *
 * @param call - The call.
 * @param op - The op `call` invokes.
 * @returns The arrow function or function expression, or undefined when the last argument is
 *   neither, when there is none, or when `op` does not iterate.
 */
export function inlineCallback(call: CallExpression, op: Op): InlineCallback | undefined {
  const last = call.arguments.at(-1);
  if (!iterates(op) || last === undefined) return undefined;
  return isArrowFunction(last) || isFunctionExpression(last) ? last : undefined;
}

/**
 * Summarizes the inline callback of an iteration call, registering the nodes it reports in the
 * scope's table. View references are classified against the site's shapes, so those must be
 * resolved first. The declaration files that resolving spawn targets consults are added to the
 * site.
 *
 * @param scope - The callback's file, with the checker, root cache, and node table.
 * @param site - The site of the call passing `fn`.
 * @param fn - The callback.
 * @returns The callback's summary.
 * @throws When a consulted declaration's source file is no longer available.
 */
export async function summarizeCallback(
  scope: CallbackScope,
  site: Site,
  fn: InlineCallback,
): Promise<Callback> {
  const register = await prepareCallback(scope, site, fn);
  return register();
}

/**
 * Runs every query a callback summary needs, leaving its nodes unregistered until the returned
 * function is called. Callbacks prepared concurrently resolve in no fixed order; registering them
 * afterwards in source order keeps a file's node IDs the same from one run to the next. The
 * declaration files that resolving spawn targets consults are added to the site before it returns.
 *
 * @param scope - The callback's file, with the checker, root cache, and node table.
 * @param site - The site of the call passing `fn`, its shapes already resolved.
 * @param fn - The callback.
 * @returns A function that registers the summary's nodes in the scope's table and gives the
 *   summary.
 * @throws When a consulted declaration's source file is no longer available.
 */
export async function prepareCallback(
  scope: CallbackScope,
  site: Site,
  fn: InlineCallback,
): Promise<() => Callback> {
  const { table } = scope;
  const binding = bindingOf(fn, scope.checker);
  const [references, hazards, functionLocal] = await Promise.all([
    classifyReferences(scope, site.shapes, fn, binding),
    hazardsOf(scope, site.shapes, fn, binding.view),
    functionLocalUses(scope.checker, fn),
  ]);
  const evalCalls = directEvalCalls(fn);
  for (const call of evalCalls) references.escape(call, "eval");
  for (const declarationFile of hazards.declarationFiles) addDeclarationFile(site, declarationFile);
  const { pattern } = binding;
  const paramNames = new Set(pattern === undefined ? [] : boundNames(pattern));
  const varDecls = ownVarDeclarations(fn);
  return () => ({
    functionLocal: functionLocal.map((node) => table.register(node)),
    viewUses: references.uses.map(({ node, ...use }) => ({ ...use, node: table.register(node) })),
    escapes: references.escapes
      .map((escape) => viewEscape(scope, escape))
      .toSorted((a, b) => a.pos.offset - b.pos.offset),
    returns: ownReturns(fn).map(({ node, nested }) => ({ node: table.register(node), nested })),
    varDecls: varDecls.map((decl) => table.register(decl)),
    paramRedeclarations: varDecls
      .filter((decl) => boundNames(decl.name).some((name) => paramNames.has(name)))
      .map((decl) => table.register(decl)),
    directEval: evalCalls.map((call) => table.register(call)),
    hazards: hazards.points.map((node) => table.register(node)),
    params: binding.params,
    firstParam: binding.firstParam,
    arrow: isArrowFunction(fn),
    async: (fn.modifierFlags & ModifierFlags.Async) !== 0,
    generator: fn.asteriskToken !== undefined,
    exprBody: !isBlock(fn.body),
  });
}

/** What a callback's parameters bind. */
interface Binding {
  /** Declared parameters, a `this` parameter left out. */
  readonly params: number;
  readonly firstParam: ParamForm;
  /** The first parameter, when it is an object pattern. */
  readonly param: ParameterDeclaration | undefined;
  /** The name of the first parameter, when it is a plain identifier: the view. */
  readonly viewName: Identifier | undefined;
  /** The object pattern of the first parameter, which destructures the view. */
  readonly pattern: ObjectBindingPattern | undefined;
  /** The symbol of `viewName`, resolving. */
  readonly view: Promise<CheckerSymbol | undefined> | undefined;
}

/**
 * What a callback's parameters bind: the view's name and symbol for an identifier, the pattern
 * for an object pattern, and nothing for any other form.
 *
 * @param fn - The callback.
 * @param checker - Checker of the program holding `fn`.
 * @returns The binding, its view's symbol still resolving.
 */
function bindingOf(fn: InlineCallback, checker: Checker): Binding {
  const params = fn.parameters.filter((param) => !isThisParameter(param));
  const [first] = params;
  const firstParam = first === undefined ? "none" : paramForm(first);
  const name = first?.name;
  const viewName =
    firstParam === "identifier" && name !== undefined && isIdentifier(name) ? name : undefined;
  const pattern =
    firstParam === "object-pattern" && name !== undefined && isObjectBindingPattern(name)
      ? name
      : undefined;
  return {
    params: params.length,
    firstParam,
    param: pattern === undefined ? undefined : first,
    viewName,
    pattern,
    view: viewName === undefined ? undefined : resolveSymbol(checker, viewName),
  };
}

function paramForm(param: ParameterDeclaration): ParamForm {
  if (param.dotDotDotToken !== undefined || param.initializer !== undefined) return "other";
  if (isIdentifier(param.name)) return "identifier";
  return isObjectBindingPattern(param.name) ? "object-pattern" : "other";
}

/**
 * Classifies the references a callback makes to its view and to aliases of the view's slots. The
 * body is scanned first, then every checker query the classification needs is issued together.
 *
 * @param scope - The callback's file and checker.
 * @param shapes - The site's resolved shapes.
 * @param fn - The callback.
 * @param binding - What the callback's parameters bind.
 * @returns The classifier holding the uses and escapes found.
 * @throws When a consulted declaration's source file is no longer available.
 */
async function classifyReferences(
  scope: CallbackScope,
  shapes: readonly ArchShape[],
  fn: InlineCallback,
  binding: Binding,
): Promise<ViewClassifier> {
  const { checker } = scope;
  const { viewName, pattern, param } = binding;
  const scan = new ReferenceScan(scope);
  if (param !== undefined) scan.walk(param);
  scan.walk(fn.body);
  const binds = viewName !== undefined || pattern !== undefined;
  const candidates = binds ? aliasCandidates(fn) : [];
  const names = new Set(candidates.map(({ name }) => name.text));
  if (viewName !== undefined) names.add(viewName.text);
  const [view, symbols, declarations, globalUndefined, loops] = await Promise.all([
    binding.view,
    scan.symbols(names),
    declaredSymbols(checker, candidates),
    binds ? scan.globalUndefined() : new Set<Node>(),
    Promise.all(scan.deferred.map(async ({ loop }) => await loop)),
  ]);
  const classifier = new ViewClassifier({
    fn,
    shapes,
    view,
    pattern,
    symbols,
    declarations,
    globalUndefined,
  });
  classifier.classifyParamPattern();
  for (const id of scan.evaluated) classifier.reference(id);
  scan.deferred.forEach(({ id }, i) => {
    classifier.nestedReference(id, loops[i]);
  });
  return classifier;
}

/**
 * The hazard points of a callback, once its view's symbol resolves.
 *
 * @param scope - The callback's file and checker.
 * @param shapes - The site's resolved shapes.
 * @param fn - The callback.
 * @param view - The view's symbol, resolving; undefined when the callback binds no view symbol.
 * @returns The hazard points and the declaration files resolving spawn targets consulted.
 * @throws When a consulted declaration's source file is no longer available.
 */
async function hazardsOf(
  scope: CallbackScope,
  shapes: readonly ArchShape[],
  fn: InlineCallback,
  view: Promise<CheckerSymbol | undefined> | undefined,
): Promise<Hazards> {
  const { checker, roots } = scope;
  return await hazardPoints({ checker, roots, shapes, view: await view }, fn);
}

async function declaredSymbols(
  checker: Checker,
  candidates: readonly AliasCandidate[],
): Promise<Map<CheckerSymbol, Node>> {
  const symbols = await Promise.all(
    candidates.map(async ({ name }) => await resolveSymbol(checker, name)),
  );
  const declarations = new Map<CheckerSymbol, Node>();
  candidates.forEach(({ decl }, i) => {
    const symbol = symbols[i];
    if (symbol !== undefined) declarations.set(symbol, decl);
  });
  return declarations;
}

function viewEscape({ table, file }: CallbackScope, escape: FoundEscape): ViewEscape {
  const pos = nodePosition(file, escape.node);
  const node = table.register(escape.node);
  if (escape.kind === "nested-loop") {
    return { pos, node, kind: escape.kind, loop: table.register(escape.loop) };
  }
  return { pos, node, kind: escape.kind };
}

/** An identifier in code that runs only when called, with the nested loop that holds it. */
interface DeferredReference {
  readonly id: Identifier;
  /**
   * The innermost iteration call whose inline callback holds the reference; undefined, or a
   * promise of undefined, when a function that is no such callback holds it.
   */
  readonly loop: Promise<CallExpression | undefined> | undefined;
}

/**
 * Collects, without querying the checker, the identifiers a callback's body can reference its view
 * through: those it evaluates, in walk order, and those in code that runs only when called. The
 * checker queries they need are then issued together.
 */
class ReferenceScan {
  readonly evaluated: Identifier[] = [];
  readonly deferred: DeferredReference[] = [];
  readonly #scope: CallbackScope;

  constructor(scope: CallbackScope) {
    this.#scope = scope;
  }

  /**
   * Collects the identifiers a node evaluates, and those of the code inside it that runs only
   * when called.
   *
   * @param node - The node to walk.
   */
  walk(node: Node): void {
    if (isIdentifier(node)) {
      if (!isNamePosition(node)) this.evaluated.push(node);
      return;
    }
    if (isNestedFunction(node)) {
      this.#scanNested(node, this.#nestedLoop(node));
    } else {
      forEachDeferred(node, (part) => {
        this.#scanNested(part, undefined);
      });
    }
    forEachEvaluated(node, (child) => {
      this.walk(child);
    });
  }

  /**
   * The symbols of the collected identifiers that spell one of a set of names: only those can
   * refer to a binding of that name.
   *
   * @param names - The names of the view and of the declarations that can alias a slot.
   * @returns Each such identifier's symbol.
   */
  async symbols(names: ReadonlySet<string>): Promise<Map<Node, CheckerSymbol | undefined>> {
    const ids = [...this.evaluated, ...this.deferred.map(({ id }) => id)].filter(({ text }) =>
      names.has(text),
    );
    const symbols = await Promise.all(
      ids.map(async (id) => await resolveSymbol(this.#scope.checker, id)),
    );
    return new Map(ids.map((id, i) => [id, symbols[i]]));
  }

  /**
   * The evaluated identifiers that read the global `undefined`.
   *
   * @returns The identifiers.
   */
  async globalUndefined(): Promise<Set<Node>> {
    const ids = this.evaluated.filter(({ text }) => text === "undefined");
    const global = await Promise.all(
      ids.map(async (id) => await isGlobalValue(this.#scope.checker, id, "undefined")),
    );
    return new Set(ids.filter((_, i) => global[i] === true));
  }

  /**
   * Collects every identifier in a node's subtree as a deferred reference. Inside an iteration
   * call's inline callback, a further function is what its own position makes it.
   *
   * @param node - The node to scan.
   * @param loop - The innermost iteration call whose inline callback holds `node`, resolving;
   *   undefined when a function that is no such callback holds it.
   */
  #scanNested(node: Node, loop: Promise<CallExpression | undefined> | undefined): void {
    if (isTypeOnly(node)) return;
    if (isIdentifier(node)) {
      if (!isNamePosition(node)) this.deferred.push({ id: node, loop });
      return;
    }
    node.forEachChild((child) => {
      const inner =
        loop !== undefined && isFunctionLikeDeclaration(child)
          ? innerLoop(loop, this.#nestedLoop(child))
          : loop;
      this.#scanNested(child, inner);
    });
  }

  /**
   * The iteration call a function is written inline as the callback of.
   *
   * @param fn - The function.
   * @returns The call, or undefined when `fn` is any other function.
   * @throws When a declaration's source file is no longer available.
   */
  async #nestedLoop(fn: Node): Promise<CallExpression | undefined> {
    const call = fn.parent;
    if (!isCallExpression(call)) return undefined;
    const recognized = await recognize(this.#scope.checker, this.#scope.roots, call);
    return recognized !== undefined && inlineCallback(call, recognized.op) === fn
      ? call
      : undefined;
  }
}

async function innerLoop(
  outer: Promise<CallExpression | undefined>,
  inner: Promise<CallExpression | undefined>,
): Promise<CallExpression | undefined> {
  const [held, own] = await Promise.all([outer, inner]);
  return held === undefined ? undefined : own;
}

/** A declaration that can alias a slot, with the identifier it binds. */
interface AliasCandidate {
  readonly decl: Node;
  readonly name: Identifier;
}

/**
 * The declarations in a callback that can alias a slot of its view: each variable declaration and
 * object-pattern property binding an identifier.
 *
 * @param fn - The callback.
 * @returns The declarations in source order.
 */
function aliasCandidates(fn: InlineCallback): AliasCandidate[] {
  const candidates: AliasCandidate[] = [];
  const visit = (node: Node): void => {
    if (isTypeOnly(node)) return;
    const declares =
      (isVariableDeclaration(node) && node.initializer !== undefined) ||
      (isBindingElement(node) && isObjectBindingPattern(node.parent));
    if (declares && node.name !== undefined && isIdentifier(node.name)) {
      candidates.push({ decl: node, name: node.name });
    }
    node.forEachChild(visit);
  };
  fn.forEachChild(visit);
  return candidates;
}
