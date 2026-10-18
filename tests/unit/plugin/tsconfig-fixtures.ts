import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

export const DESCRIPTOR_SOURCE = join(REPO_ROOT, "src", "plugin", "optimizer.ts");

/** A plugin entry naming the descriptor by its package subpath. */
export const ECSTATIC_ENTRY = { transform: "ecstatic/optimizer" };

/** A plugin entry naming a transform that is not ecstatic's. */
export const OTHER_ENTRY = { transform: "banana/transform" };

const createdDirectories: string[] = [];

/** Removes every directory `createTempDir` made; register it with `afterEach`. */
export function removeTempDirs(): void {
  for (const dir of createdDirectories.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Creates an empty temp directory that `removeTempDirs` deletes.
 *
 * @param parent - Existing directory to create it in; the system temp directory when omitted.
 * @returns The new directory's real path.
 * @throws Error when `parent` does not exist or a directory cannot be created in it.
 */
export function createTempDir(parent: string = tmpdir()): string {
  const dir = mkdtempSync(join(realpathSync(parent), "ecstatic-plugin-"));
  createdDirectories.push(dir);
  return dir;
}

/**
 * Writes `content` to `file`, creating parent directories first.
 *
 * @param file - Absolute path of the file to write.
 * @param content - Written as-is when a string, otherwise serialized with `JSON.stringify`.
 * @throws Error when a directory cannot be created or the file cannot be written.
 */
export function writeFixture(file: string, content: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, typeof content === "string" ? content : JSON.stringify(content));
}

/** Writes each `relative path → content` pair under `dir`. */
export function writeFixtures(dir: string, files: Record<string, unknown>): void {
  for (const [relative, content] of Object.entries(files)) {
    writeFixture(join(dir, relative), content);
  }
}

/** Creates a temp directory holding `files` (see `writeFixtures`) and returns its real path. */
export function createProject(files: Record<string, unknown>): string {
  const dir = createTempDir();
  writeFixtures(dir, files);
  return dir;
}

/** A tsconfig whose `compilerOptions.plugins` lists `entries`. */
export function withPlugins(...entries: unknown[]): { compilerOptions: { plugins: unknown[] } } {
  return { compilerOptions: { plugins: entries } };
}
