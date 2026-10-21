import { readdirSync, realpathSync } from "node:fs";
import { basename, dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { assert, vi } from "vitest";

import { projectPath } from "../unit/optimizer/project.js";

/** The directory that holds every fixture, by its real path. */
export const CORPUS_ROOT = realpathSync(fileURLToPath(new URL("fixtures", import.meta.url)));

/** The file each fixture directory holds its input in. */
export const INPUT_FILE = "input.ts";

/** The file each fixture directory holds its rewritten input in. */
export const GOLDEN_FILE = "expected.ts.golden";

/**
 * The category whose golden files diverge from their inputs by design: a cast lies about the
 * storage's shape, so the guard throws where the runtime does not. `shape-guard.test.ts` covers it.
 */
const DIVERGENT = "divergent/";

/** The slash-separated directory of `file` relative to the corpus root, `.` for the root itself. */
export function fixtureOf(file: string): string {
  const dir = relative(CORPUS_ROOT, dirname(file));
  return dir === "" ? "." : dir.split(sep).join("/");
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

/** Every fixture whose golden behaves as its input does: all but the divergent ones. */
export const CONVERGENT_FIXTURES = FIXTURES.filter((fixture) => !fixture.startsWith(DIVERGENT));

/**
 * Imports a fixture module against a fresh module registry.
 *
 * @param file - The absolute path of the module.
 * @param name - The name of the function the module exports.
 * @returns A function that calls the export with the arguments it is given.
 * @throws AssertionError when the module exports no function named `name`.
 */
export async function loadFixtureExport(
  file: string,
  name: string,
): Promise<(...args: unknown[]) => unknown> {
  vi.resetModules();
  const module: unknown = await import(file);
  assert(typeof module === "object" && module !== null && name in module);
  const fn: unknown = Reflect.get(module, name);
  assert(typeof fn === "function", `${file} does not export a ${name} function`);
  return (...args) => fn(...args);
}
