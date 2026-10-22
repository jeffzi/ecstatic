import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { assert, vi } from "vitest";

import { projectPath, relativePath } from "../unit/optimizer/project.js";

/** The directory that holds every fixture, by its real path. */
export const CORPUS_ROOT = realpathSync(fileURLToPath(new URL("fixtures", import.meta.url)));

/** A directory is a fixture exactly when it holds this file; `FIXTURES` is discovered by it. */
export const INPUT_FILE = "input.ts";

/**
 * Rewritten by `npx vitest run --project fixtures -u`. Golden files under `divergent/` differ from
 * the input by design.
 */
export const GOLDEN_FILE = "expected.ts.golden";

/**
 * The category whose golden files diverge from their inputs by design: a cast lies about the
 * storage's shape, so the guard throws where the runtime does not. `shape-guard.test.ts` covers it.
 */
const DIVERGENT = "divergent/";

/** The slash-separated directory of `file` relative to the corpus root, `.` for the root itself. */
export function fixtureOf(file: string): string {
  const dir = relativePath(CORPUS_ROOT, dirname(file));
  return dir === "" ? "." : dir;
}

/** The absolute path of `name` in `fixture`. */
export function fixturePath(fixture: string, name: string): string {
  return join(projectPath(CORPUS_ROOT, fixture), name);
}

/** Every `.ts` file of the corpus, absolute and sorted. */
export const CORPUS_FILES = readdirSync(CORPUS_ROOT, { recursive: true, encoding: "utf8" })
  .filter((rel) => rel.endsWith(".ts"))
  .map((rel) => join(CORPUS_ROOT, rel))
  .toSorted();

/** Every fixture directory of the corpus, found by its `input.ts`, sorted. */
export const FIXTURES = CORPUS_FILES.filter((file) => basename(file) === INPUT_FILE)
  .map(fixtureOf)
  .toSorted();

/** Whether `fixture`'s golden exists and is byte-identical to its input: the input left as written. */
function goldenCopiesInput(fixture: string): boolean {
  const golden = fixturePath(fixture, GOLDEN_FILE);
  return (
    existsSync(golden) &&
    readFileSync(golden, "utf8") === readFileSync(fixturePath(fixture, INPUT_FILE), "utf8")
  );
}

/**
 * Every fixture whose golden behaves as its input does but is not a copy of it: the rewritten
 * fixtures outside `divergent/`. A fixture left as written has nothing to compare; one with no
 * golden yet stays in, so the list loads before `-u` writes its first golden.
 */
export const REWRITTEN_CONVERGENT_FIXTURES = FIXTURES.filter(
  (fixture) => !fixture.startsWith(DIVERGENT) && !goldenCopiesInput(fixture),
);

/**
 * Imports a fixture module against a fresh module registry.
 *
 * @param file - The absolute path of the module.
 * @param name - The name of the function the module exports.
 * @returns A function that calls the export with the arguments it is given.
 * @throws AssertionError when the module exports no function named `name`.
 * @throws Error when `file` cannot be resolved or throws while it loads.
 */
export async function loadFixtureExport(
  file: string,
  name: string,
): Promise<(...args: unknown[]) => unknown> {
  vi.resetModules();
  const module: unknown = await import(file);
  return boundMember(module, name, undefined, `${file} does not export a ${name} function`);
}

/**
 * Looks up the function `name` on `target` and binds it to `receiver`.
 *
 * @param target - The object that holds the function.
 * @param name - The name of the function.
 * @param receiver - The `this` the function is called with.
 * @param message - The failure message when `target` has no function named `name`.
 * @returns A function that calls the member on `receiver` with the arguments it is given.
 * @throws AssertionError when `target` is not an object or has no function named `name`.
 */
export function boundMember(
  target: unknown,
  name: string,
  receiver: unknown,
  message?: string,
): (...args: unknown[]) => unknown {
  assert(typeof target === "object" && target !== null);
  const fn: unknown = Reflect.get(target, name);
  assert(typeof fn === "function", message);
  return (...args) => fn.call(receiver, ...args);
}
