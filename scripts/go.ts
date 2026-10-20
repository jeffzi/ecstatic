import { spawnSync } from "node:child_process";
import { constants } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { errorMessage, isSystemError } from "./caught.js";
import { isEntryScript } from "./entry.js";
import { GIB, trimGoCache } from "./trim-go-cache.js";

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

const SCRIPT_PATH = fileURLToPath(import.meta.url);

/**
 * The `Cache Go builds` steps in `.github/workflows/ci.yml` and the commands in `AGENTS.md` name
 * this folder; moving it means updating both.
 */
const PROJECT_CACHE = join(dirname(dirname(SCRIPT_PATH)), "node_modules", ".cache", "go-build");

function trimProjectCache(projectCache: string): void {
  try {
    trimGoCache(projectCache, {
      now: Date.now(),
      cap: CAP,
      target: TARGET,
      protectedAge: PROTECTED_AGE,
    });
  } catch (error) {
    // The trim wraps every filesystem failure with the system error as its cause; anything else
    // is a bug in the trim and must stop the run with its stack.
    if (!(error instanceof Error && isSystemError(error.cause))) {
      throw error;
    }
    process.stderr.write(`Skipped trimming the Go build cache: ${errorMessage(error)}\n`);
  }
}

/**
 * Run `go` against the project's own build cache unless the caller chose one.
 *
 * With `GOCACHE` unset or empty, `go` runs with `GOCACHE` set to the project folder, which is
 * trimmed first. A filesystem failure during the trim is reported on one stderr line and does not
 * stop `go`. A non-empty `GOCACHE` belongs to the caller: it is passed through and never trimmed.
 * `go` inherits stdio and runs without a shell, so the same command works on Windows. When `go`
 * is killed by a signal, `go was killed by <signal>` is printed to stderr.
 *
 * @param args - The arguments passed to `go` unchanged.
 * @param env - The environment `go` runs in, before `GOCACHE` is set.
 * @param projectCache - The project folder `GOCACHE` is set to and trimmed when `env` has none.
 * @returns `go`'s exit code; 128 plus the signal's number when `go` was killed by a signal; or 1
 * when `go` could not start, in which case the error is printed to stderr.
 * @throws Any error from the trim other than a filesystem failure, before `go` runs.
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

  const goRun = spawnSync("go", args, { stdio: "inherit", env: goEnv });
  if (goRun.error !== undefined) {
    process.stderr.write(`cannot run go: ${goRun.error.message}\n`);
    return 1;
  }
  if (goRun.signal !== null) {
    process.stderr.write(`go was killed by ${goRun.signal}\n`);
    return 128 + constants.signals[goRun.signal];
  }
  return goRun.status ?? 1;
}

if (isEntryScript(import.meta.url)) {
  process.exitCode = runGo(process.argv.slice(2), process.env, PROJECT_CACHE);
}
