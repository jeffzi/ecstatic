import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

/** The repository's root directory. */
export const REPO_ROOT = resolve(import.meta.dirname, "../../..");

const createdDirectories: string[] = [];

/** Removes every directory `createProject` made; call it from the hook matching the one that created the project. */
export function removeTempDirs(): void {
  for (const dir of createdDirectories.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Creates an empty temp directory, by its real path, that `removeTempDirs` deletes. The native
 * real path expands a Windows 8.3 short name such as `RUNNER~1`, as Vite does with its root, so a
 * module id built from the directory matches the ids Vite gives.
 */
function createTempDir(): string {
  const dir = mkdtempSync(join(realpathSync.native(tmpdir()), "ecstatic-plugin-"));
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
function writeFixtures(dir: string, files: Record<string, unknown>): void {
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
