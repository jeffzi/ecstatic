import type { FunctionDeclaration, Node } from "typescript/ast";
import { isFunctionDeclaration, isIdentifier } from "typescript/ast/is";
import { type Checker, type Symbol as CheckerSymbol, SymbolFlags } from "typescript/async";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { iterates, matchesArgCount, type Op, OPS } from "../../../src/plugin/optimizer/facts.js";
import type { ProjectView, Session } from "../../../src/plugin/optimizer/session.js";
import {
  closeProject,
  openProject,
  projectPath,
  runtimeProject,
  SPAWN_TIMEOUT_MS,
} from "./project.js";

/**
 * The highest argument count the overload checks probe. It must be at least the largest parameter
 * count of any `each` or `query` overload: {@link overloadArgCounts} fails when an overload exceeds
 * it.
 */
const MAX_PROBED_ARG_COUNT = 6;

/** The project file each overload case's source is served as. */
const OVERLOAD_FILE = "app/overload.ts";

/** An overload parameter read with an initializer, which TypeScript forbids in an overload. */
class OverloadInitializerError extends Error {}

let root = "";
let session: Session;
let view: ProjectView;

beforeAll(async () => {
  ({ root, session, view } = await openProject(
    runtimeProject({ [OVERLOAD_FILE]: "export {};\n" }),
  ));
}, SPAWN_TIMEOUT_MS);

afterAll(() => closeProject(session));

/** The symbol `symbol` names: its alias target when it is an alias, else itself. */
async function aliasTarget(checker: Checker, symbol: CheckerSymbol): Promise<CheckerSymbol> {
  return (symbol.flags & SymbolFlags.Alias) === 0 ? symbol : checker.getAliasedSymbol(symbol);
}

/** The runtime index's exports, each paired with the symbol it names. */
async function indexExports(): Promise<
  { readonly name: string; readonly target: CheckerSymbol }[]
> {
  const { checker } = view;
  const index = await checker.getSymbolOfSourceFile(projectPath(root, "src/ecstatic/index.ts"));
  if (index === undefined) throw new Error("the runtime index has no module symbol");
  const exported = await checker.getExportsOfModule(index);
  const targets = await Promise.all(exported.map(async (symbol) => aliasTarget(checker, symbol)));
  return exported.map((symbol, i) => ({ name: symbol.name, target: targets[i] ?? symbol }));
}

/** The names of the functions the runtime index exports, sorted. */
async function indexFunctionExports(): Promise<string[]> {
  const exported = await indexExports();
  return exported
    .filter(({ target }) => (target.flags & SymbolFlags.Function) !== 0)
    .map(({ name }) => name)
    .toSorted();
}

/**
 * Reads the argument counts the overloads accept. An overload accepts every count from its required
 * parameters to all of them; a `this` parameter is never passed, so it is not counted. The one
 * declaration with a body is the implementation, whose parameters are not read.
 *
 * @param declarations - The declarations of one function: its overloads and its implementation.
 * @returns The argument counts the overloads accept, sorted.
 * @throws OverloadInitializerError when an overload parameter has an initializer.
 * @throws Error for a declaration that is not a function, a rest parameter, an overload with more
 *   than {@link MAX_PROBED_ARG_COUNT} parameters, no overload, or more than one body.
 */
function overloadArgCounts(declarations: readonly Node[]): number[] {
  const counts = new Set<number>();
  let bodies = 0;
  for (const declaration of declarations) {
    if (!isFunctionDeclaration(declaration)) {
      throw new Error(`declaration at ${declaration.pos} is not a function declaration`);
    }
    if (declaration.body !== undefined) {
      bodies++;
      continue;
    }
    const { required, total } = parameterArity(declaration);
    if (total > MAX_PROBED_ARG_COUNT) {
      throw new Error(`an overload takes ${total} parameters; raise MAX_PROBED_ARG_COUNT`);
    }
    for (let count = required; count <= total; count++) counts.add(count);
  }
  if (counts.size === 0 || bodies > 1) {
    throw new Error(`found ${counts.size} overload counts and ${bodies} bodies`);
  }
  return [...counts].toSorted((a, b) => a - b);
}

/** The required and total argument counts of the overload `declaration`. */
function parameterArity(declaration: FunctionDeclaration): { required: number; total: number } {
  let required = 0;
  let total = 0;
  for (const param of declaration.parameters) {
    if (isIdentifier(param.name) && param.name.text === "this") continue;
    if (param.dotDotDotToken !== undefined) {
      throw new Error("a rest parameter has no fixed arity");
    }
    if (param.initializer !== undefined) {
      throw new OverloadInitializerError("overload parameter has an initializer");
    }
    total++;
    if (param.questionToken === undefined) required++;
  }
  return { required, total };
}

/** The argument counts the overloads of the function `name` the runtime index exports accept. */
async function declaredArgCounts(name: string): Promise<number[]> {
  const exported = await indexExports();
  const found = exported.find((entry) => entry.name === name);
  if (found === undefined) throw new Error(`the runtime index exports no ${name}`);
  const declarations = await Promise.all(
    found.target.declarations.map(async (handle) => handle.resolve()),
  );
  return overloadArgCounts(declarations.filter((node) => node !== undefined));
}

/** The counts up to {@link MAX_PROBED_ARG_COUNT} that `op` accepts. */
function acceptedArgCounts(op: Op): number[] {
  return Array.from({ length: MAX_PROBED_ARG_COUNT + 1 }, (_, count) => count).filter((count) =>
    matchesArgCount(op, count),
  );
}

/** The argument counts of the functions named `f` in `source`, served as the overload file. */
async function overloadArgCountsIn(source: string): Promise<number[]> {
  const file = projectPath(root, OVERLOAD_FILE);
  const served = await session.update({ [file]: source });
  const parsed = await served.sourceFile(file);
  return overloadArgCounts(
    parsed.statements.filter(
      (statement) => isFunctionDeclaration(statement) && statement.name?.text === "f",
    ),
  );
}

describe("OPS", () => {
  it("names every function the runtime index exports", async () => {
    const exported = await indexFunctionExports();

    expect([...OPS].toSorted()).toStrictEqual(exported);
  });
});

describe("iterates", () => {
  it.each(OPS)("agrees with the overload data for %s", (op) => {
    const accepted = acceptedArgCounts(op);

    expect(iterates(op)).toBe(accepted.length > 0);
  });
});

describe("matchesArgCount", () => {
  it.each(OPS.filter((op) => iterates(op)))(
    "accepts the counts the overloads of %s declare",
    async (op) => {
      const declared = await declaredArgCounts(op);

      expect(acceptedArgCounts(op)).toStrictEqual(declared);
    },
  );
});

describe("overloadArgCounts", () => {
  it.each([
    {
      name: "line comment with a colon before an optional parameter",
      source: "export function f(a: A, // note: x\n\tfn?: F): void;",
      expected: [1, 2],
    },
    {
      name: "block comment with a colon before an optional parameter",
      source: "export function f(a: A, /* see: b */ b?: B): void;",
      expected: [1, 2],
    },
    {
      name: "string literal type containing an equals sign",
      source: 'export function f(mode: "a=b"): void;',
      expected: [1],
    },
    {
      name: "single-quoted literal type containing a colon and an equals sign",
      source: "export function f(mode: 'k:v=1'): void;",
      expected: [1],
    },
    {
      name: "template literal type containing an equals sign",
      source: "export function f(key: `x=${string}`): void;",
      expected: [1],
    },
    {
      name: "this parameter is not an argument",
      source: "export function f(this: World, a: A): void;",
      expected: [1],
    },
    {
      name: "arrow function type is not an initializer",
      source: "export function f(fn: (x: X) => void): void;",
      expected: [1],
    },
    {
      name: "default in the implementation signature is ignored",
      source: "export function f(a: A): void;\nexport function f(a: A, b = 1): void {}",
      expected: [1],
    },
  ])("counts the arguments with a $name", async ({ source, expected }) => {
    const counts = await overloadArgCountsIn(source);

    expect(counts).toStrictEqual(expected);
  });

  it.each([
    { name: "untyped default", source: "export function f(a = 1): void;" },
    {
      name: "default after a string literal type",
      source: 'export function f(mode: "a" = "a"): void;',
    },
    {
      name: "default after an arrow function type",
      source: "export function f(fn: () => void = done): void;",
    },
  ])("fails on an overload parameter with an $name", async ({ source }) => {
    const counting = overloadArgCountsIn(source);

    await expect(counting).rejects.toThrow(OverloadInitializerError);
  });
});
