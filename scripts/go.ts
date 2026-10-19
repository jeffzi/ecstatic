import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { trimGoCache } from "./trim-go-cache.js";

const GIB = 2 ** 30;
/** The project folder's total entry size above which a run trims it. */
const CAP = 8 * GIB;
/** The total entry size a trim brings the project folder down to. */
const TARGET = 6 * GIB;
/**
 * Go refreshes an entry's mtime on use only when it is at least an hour old, so an entry a running
 * build resolved within the last hour has an mtime under 2 h old. Deleting such an entry fails that
 * build.
 */
const PROTECTED_AGE = 2 * 60 * 60 * 1000;

/**
 * The `Cache Go builds` steps in `.github/workflows/ci.yml` and the commands in `AGENTS.md` name
 * this folder; moving it means updating both.
 */
const PROJECT_CACHE = join(
  dirname(dirname(fileURLToPath(import.meta.url))),
  "node_modules",
  ".cache",
  "go-build",
);

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function trimProjectCache(projectCache: string): void {
  try {
    trimGoCache(projectCache, {
      now: Date.now(),
      cap: CAP,
      target: TARGET,
      protectedAge: PROTECTED_AGE,
    });
  } catch (error) {
    process.stderr.write(`Skipped trimming the Go build cache: ${errorMessage(error)}\n`);
  }
}

/**
 * Run `go` against the project's own build cache unless the caller chose one.
 *
 * With `GOCACHE` unset or empty, `go` runs with `GOCACHE` set to the project folder, which is
 * trimmed first. A failed trim is reported on one stderr line and does not stop `go`. A non-empty
 * `GOCACHE` belongs to the caller: it is passed through and never trimmed. `go` inherits stdio and
 * runs without a shell, so the same command works on Windows.
 *
 * @param args - The arguments passed to `go` unchanged.
 * @param env - The environment `go` runs in, before `GOCACHE` is set.
 * @param projectCache - The project folder `GOCACHE` is set to and trimmed when `env` has none.
 * @returns `go`'s exit code, or 1 when `go` was killed by a signal or could not start; in the latter
 * case the error is printed to stderr.
 */
export function runGo(
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  projectCache: string,
): number {
  let goEnv = env;
  if ((env["GOCACHE"] ?? "") === "") {
    goEnv = { ...env, GOCACHE: projectCache };
    trimProjectCache(projectCache);
  }

  const result = spawnSync("go", args, { stdio: "inherit", env: goEnv });
  if (result.error !== undefined) {
    process.stderr.write(`cannot run go: ${result.error.message}\n`);
    return 1;
  }
  return result.status ?? 1;
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  process.exitCode = runGo(process.argv.slice(2), process.env, PROJECT_CACHE);
}
