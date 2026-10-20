import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { constants } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runGo } from "../../scripts/go.js";
import { trimGoCache } from "../../scripts/trim-go-cache.js";
import { packageBin } from "../package-bin.js";
import { GIB, HOUR, survivors, writeEntry } from "./go-cache-fixtures.js";
import { createTempDir, removeTempDirs } from "./plugin/tsconfig-fixtures.js";

// Calls through to the real trim, so the in-process tests can read the limits runGo passes it.
vi.mock("../../scripts/trim-go-cache.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../scripts/trim-go-cache.js")>();
  return { ...actual, trimGoCache: vi.fn(actual.trimGoCache) };
});

const ROOT = realpathSync(fileURLToPath(new URL("../..", import.meta.url)));
const TSX = packageBin("tsx", "tsx");
const PROJECT_CACHE = join("node_modules", ".cache", "go-build");

/** npm on Windows cannot run a shell-script `go`, and NTFS allocates sparse multi-GiB files. */
const POSIX = process.platform !== "win32";

afterEach(removeTempDirs);

/** A temp repository root holding copies of the wrapper, the trim, and their shared helpers in `scripts/`. */
function project(): string {
  const root = createTempDir();
  mkdirSync(join(root, "scripts"));
  for (const name of ["go.ts", "trim-go-cache.ts", "caught.ts", "entry.ts"]) {
    copyFileSync(join(ROOT, "scripts", name), join(root, "scripts", name));
  }
  writeFileSync(join(root, "package.json"), '{ "type": "module" }\n');
  return root;
}

/**
 * Builds a temp repository root holding the project's `package.json`, the scripts its Go npm
 * scripts run, and `tsx` in `node_modules/.bin`, so those npm scripts run there instead of in the
 * repository.
 *
 * @returns The path of the temp repository root.
 */
function npmProject(): string {
  const root = project();
  copyFileSync(join(ROOT, "package.json"), join(root, "package.json"));
  copyFileSync(
    join(ROOT, "scripts", "check-go-coverage.ts"),
    join(root, "scripts", "check-go-coverage.ts"),
  );
  mkdirSync(join(root, "node_modules", ".bin"), { recursive: true });
  symlinkSync(TSX, join(root, "node_modules", ".bin", "tsx"));
  return root;
}

/** A temp directory holding a shell-script `go` that runs `body`, for use on `PATH`. */
function fakeGo(body: string): string {
  const bin = createTempDir();
  const go = join(bin, "go");
  writeFileSync(go, `#!/bin/sh\n${body}\n`);
  chmodSync(go, 0o755);
  return bin;
}

/**
 * A fake `go` that writes the GOCACHE it received and its arguments, one per line, to `record`,
 * then runs `after`.
 *
 * @param after - Shell commands the fake `go` runs after recording, which set its exit status.
 * @returns The directory holding the fake `go`, for use on `PATH`, and the path of the `record` file.
 */
function recordingGo(after = "exit 0"): { bin: string; record: string } {
  const record = join(createTempDir(), "call");
  const bin = fakeGo(`printf '%s\\n' "$GOCACHE" "$@" > '${record}'\n${after}`);
  return { bin, record };
}

/** The current environment without GOCACHE, with `path` as `PATH` and `extra` added. */
function environment(path: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const base = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !["PATH", "GOCACHE"].includes(key.toUpperCase())),
  );
  return { ...base, PATH: path, ...extra };
}

/** Runs the wrapper copied into `root` with `args` and `env`, from a directory other than `root`. */
function runWrapper(
  root: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): SpawnSyncReturns<string> {
  return spawnSync(process.execPath, [TSX, join(root, "scripts", "go.ts"), ...args], {
    cwd: createTempDir(),
    env,
    encoding: "utf8",
  });
}

describe("scripts/go.ts", () => {
  describe("when GOCACHE is unset or empty", () => {
    it.runIf(POSIX).each([
      { state: "unset", extra: {} },
      { state: "empty", extra: { GOCACHE: "" } },
    ])(
      "runs go with its arguments and GOCACHE set to the project folder when $state",
      ({ extra }) => {
        const root = project();
        const { bin, record } = recordingGo();

        runWrapper(root, ["test", "./...", "-run", "two words"], environment(bin, extra));

        expect(readFileSync(record, "utf8")).toBe(
          [join(root, PROJECT_CACHE), "test", "./...", "-run", "two words", ""].join("\n"),
        );
      },
    );

    it.runIf(POSIX).each([
      {
        total: "exactly 8 GiB",
        sizes: [2 * GIB, 2 * GIB, 2 * GIB, 2 * GIB],
        expected: [true, true, true, true],
      },
      {
        total: "1 B over 8 GiB, oldest entry largest",
        sizes: [2 * GIB + 1, 2 * GIB, 2 * GIB, 2 * GIB],
        expected: [false, true, true, true],
      },
      {
        total: "1 B over 8 GiB, newest entry largest",
        sizes: [2 * GIB, 2 * GIB, 2 * GIB, 2 * GIB + 1],
        expected: [false, false, true, true],
      },
    ])(
      "trims a project folder of $total against an 8 GiB cap and a 6 GiB target",
      ({ sizes, expected }) => {
        const root = project();
        const ages = [5 * HOUR, 4 * HOUR, 3 * HOUR, 2.5 * HOUR];
        const entries = sizes.map((size, index) =>
          writeEntry(join(root, PROJECT_CACHE), `0${index}`, size, ages[index] ?? 0),
        );

        runWrapper(root, ["version"], environment(recordingGo().bin));

        expect(survivors(entries)).toStrictEqual(expected);
      },
    );
  });

  describe("when GOCACHE is set", () => {
    it.runIf(POSIX)("runs go with that GOCACHE and trims neither it nor the project folder", () => {
      const root = project();
      const cache = createTempDir();
      const entries = [
        writeEntry(cache, "00", 9 * GIB, 5 * HOUR),
        writeEntry(join(root, PROJECT_CACHE), "00", 9 * GIB, 5 * HOUR),
      ];
      const { bin, record } = recordingGo();

      runWrapper(root, ["version"], environment(bin, { GOCACHE: cache }));

      expect(readFileSync(record, "utf8")).toBe(`${cache}\nversion\n`);
      expect(survivors(entries)).toStrictEqual([true, true]);
    });
  });

  describe("when the trim fails", () => {
    it.runIf(POSIX)(
      "prints one stderr line naming the project folder, then runs go and exits with its code",
      () => {
        const root = project();
        const folder = join(root, PROJECT_CACHE);
        mkdirSync(dirname(folder), { recursive: true });
        writeFileSync(folder, "");
        const { bin, record } = recordingGo("exit 3");

        const result = runWrapper(root, ["version"], environment(bin));

        expect(result.stderr.trimEnd().split("\n")).toStrictEqual([
          expect.stringContaining(folder),
        ]);
        expect(existsSync(record)).toBe(true);
        expect(result.status).toBe(3);
      },
    );
  });

  describe("when go runs", () => {
    it.runIf(POSIX)("passes go's stdout, stderr and exit code through unchanged", () => {
      const bin = fakeGo("echo out\necho err >&2\nexit 7");

      const result = runWrapper(project(), ["version"], environment(bin));

      expect({ status: result.status, stdout: result.stdout, stderr: result.stderr }).toStrictEqual(
        { status: 7, stdout: "out\n", stderr: "err\n" },
      );
    });

    it.runIf(POSIX).each(["SIGKILL", "SIGTERM"] as const)(
      "prints the signal and exits 128 plus its number when go is killed by %s",
      (signal) => {
        const bin = fakeGo(`kill -${signal.slice(3)} $$`);

        const { status, stderr } = runWrapper(project(), ["version"], environment(bin));

        expect({ status, stderr }).toStrictEqual({
          status: 128 + constants.signals[signal],
          stderr: `go was killed by ${signal}\n`,
        });
      },
    );

    it.runIf(POSIX)("runs go when the script path goes through a symlinked directory", () => {
      const link = join(createTempDir(), "linked");
      symlinkSync(project(), link, "dir");
      const { bin, record } = recordingGo();

      const { status } = runWrapper(link, ["version"], environment(bin));

      expect({ status, called: existsSync(record) }).toStrictEqual({ status: 0, called: true });
    });

    it("prints the error and exits 1 when go cannot start", () => {
      const result = runWrapper(project(), ["version"], environment(createTempDir()));

      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(/^cannot run go: .*ENOENT/);
    });
  });
});

describe("runGo", () => {
  beforeEach(() => {
    vi.mocked(trimGoCache).mockClear();
  });

  it.runIf(POSIX).each([
    { state: "unset", extra: {} },
    { state: "empty", extra: { GOCACHE: "" } },
  ])(
    "trims the project folder with an 8 GiB cap, a 6 GiB target and a 2 h window when GOCACHE is $state",
    ({ extra }) => {
      const cache = join(createTempDir(), "go-build");
      const { bin } = recordingGo();

      runGo(["version"], environment(bin, extra), cache);

      expect(vi.mocked(trimGoCache)).toHaveBeenCalledExactlyOnceWith(cache, {
        now: expect.any(Number),
        cap: 8 * GIB,
        target: 6 * GIB,
        protectedAge: 2 * HOUR,
      });
    },
  );

  it.runIf(POSIX).each([
    { kind: "a TypeError", error: new TypeError("banana is not a function") },
    {
      kind: "an error wrapping a cause without a code",
      error: new Error("cannot read banana", { cause: new Error("inner") }),
    },
  ])("rethrows $kind from the trim without running go", ({ error }) => {
    vi.mocked(trimGoCache).mockImplementationOnce(() => {
      throw error;
    });
    const cache = join(createTempDir(), "go-build");
    const { bin, record } = recordingGo();

    const run = (): number => runGo(["version"], environment(bin), cache);

    expect(run).toThrow(error);
    expect(existsSync(record)).toBe(false);
  });

  it.runIf(POSIX)("trims the project folder before go starts", () => {
    const cache = join(createTempDir(), "go-build");
    const stale = writeEntry(cache, "00", 8 * GIB + 1, 5 * HOUR);
    const record = join(createTempDir(), "call");
    const bin = fakeGo(`if [ -e '${stale}' ]; then echo kept; else echo trimmed; fi > '${record}'`);

    runGo(["version"], environment(bin), cache);

    expect(readFileSync(record, "utf8")).toBe("trimmed\n");
  });
});

describe("npm scripts", () => {
  it.runIf(POSIX).each([
    { script: "lint:go", calls: 2 },
    { script: "test:go", calls: 1 },
  ])(
    "$script runs each go command with GOCACHE set to the project folder, trimmed first",
    ({ script, calls }) => {
      const root = npmProject();
      const stale = writeEntry(join(root, PROJECT_CACHE), "00", 8 * GIB + 1, 5 * HOUR);
      const record = join(createTempDir(), "calls");
      const bin = fakeGo(`printf '%s\\n' "$GOCACHE" >> '${record}'`);

      spawnSync("npm", ["run", "--silent", script], {
        cwd: root,
        env: environment(`${bin}${delimiter}${process.env["PATH"] ?? ""}`),
        encoding: "utf8",
      });

      expect(readFileSync(record, "utf8").trimEnd().split("\n")).toStrictEqual(
        Array.from({ length: calls }, () => join(root, PROJECT_CACHE)),
      );
      expect(existsSync(stale)).toBe(false);
    },
  );
});
