import { readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";

import type { CallExpression, Identifier, Node } from "typescript/ast";
import { isIdentifier, isPropertyAccessExpression } from "typescript/ast/is";

import { type Checker, declarationFileNames, resolveSymbol, symbolName } from "../compiler.js";
import { type Op, opByName } from "../facts.js";

/** A path, relative to a package root, inside its runtime: its sources or its build. */
const RUNTIME_PATH = /^(?:src|dist)[/\\]/;

/**
 * Finds ecstatic package roots: the directories whose `package.json` is named `ecstatic`. Each
 * directory's answer is cached, so one instance should serve a whole run.
 */
export class PackageRoots {
  readonly #byDir = new Map<string, string | undefined>();

  /**
   * The nearest ancestor directory of a file that is an ecstatic package root. A `package.json`
   * that is missing, unreadable, not valid JSON, or named otherwise does not make its directory a
   * root; the search continues upward past it.
   *
   * @param fileName - Absolute file name.
   * @returns The root directory, or undefined when no ancestor is one.
   */
  root(fileName: string): string | undefined {
    return this.#rootOf(dirname(fileName));
  }

  /**
   * The root of the ecstatic package whose runtime holds a file: the file lies in the `src/` or
   * `dist/` directory of its root. Rooting the test at those two directories keeps out the root's
   * own dependencies, which for the ecstatic repository sit in `node_modules/` under the same root.
   *
   * @param fileName - Absolute file name.
   * @returns The package root, or undefined when the file is not runtime code.
   */
  runtimeRoot(fileName: string): string | undefined {
    const root = this.root(fileName);
    if (root === undefined || !RUNTIME_PATH.test(relative(root, fileName))) return undefined;
    return root;
  }

  #rootOf(dir: string): string | undefined {
    if (this.#byDir.has(dir)) return this.#byDir.get(dir);
    const parent = dirname(dir);
    let root: string | undefined;
    if (isEcstaticPackage(dir)) root = dir;
    else if (parent !== dir) root = this.#rootOf(parent);
    this.#byDir.set(dir, root);
    return root;
  }
}

/**
 * Whether a directory holds a `package.json` named `ecstatic`. A manifest that cannot be read or
 * decoded is, by the definition of a root, not one, so its error is the answer rather than a
 * failure.
 *
 * @param dir - The directory to test.
 * @returns Whether `dir` is an ecstatic package root.
 */
function isEcstaticPackage(dir: string): boolean {
  let manifest: unknown;
  try {
    manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  } catch {
    return false;
  }
  return (
    typeof manifest === "object" &&
    manifest !== null &&
    "name" in manifest &&
    manifest.name === "ecstatic"
  );
}

/** A call into an ecstatic runtime. */
export interface Recognized {
  readonly op: Op;
  /** The package root whose runtime declares the called function. */
  readonly root: string;
}

/**
 * Recognizes a call of an ecstatic op. A callee reached through a variable (`const myEach = each`)
 * resolves to that variable, which no runtime declares, so the call stays a runtime call.
 *
 * @param checker - Checker of the program holding `call`.
 * @param roots - The package root cache.
 * @param call - The call to recognize.
 * @returns The op and the root whose runtime declares the callee, or undefined when the callee does
 *   not resolve to a function an ecstatic runtime declares.
 * @throws When a declaration's source file is no longer available.
 */
export async function recognize(
  checker: Checker,
  roots: PackageRoots,
  call: CallExpression,
): Promise<Recognized | undefined> {
  const name = calleeName(call.expression);
  if (name === undefined) return undefined;
  const symbol = await resolveSymbol(checker, name);
  if (symbol === undefined) return undefined;
  const files = await declarationFileNames(symbol);
  const root = files.map((file) => roots.runtimeRoot(file)).find((dir) => dir !== undefined);
  if (root === undefined) return undefined;
  const op = opByName(symbolName(symbol));
  return op === undefined ? undefined : { op, root };
}

/**
 * The identifier naming a callee: the callee itself (`each(...)`) or the property of a namespace
 * access (`ecs.each(...)`).
 *
 * @param callee - The call's callee.
 * @returns The identifier, or undefined for any other callee shape.
 */
function calleeName(callee: Node): Identifier | undefined {
  if (isIdentifier(callee)) return callee;
  if (isPropertyAccessExpression(callee) && isIdentifier(callee.name)) return callee.name;
  return undefined;
}
