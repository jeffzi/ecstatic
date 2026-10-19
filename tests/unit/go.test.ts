import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  truncateSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runGo } from "../../scripts/go.js";
import { trimGoCache } from "../../scripts/trim-go-cache.js";
import { packageBin } from "../package-bin.js";

// Calls through to the real trim, so the in-process tests can read the limits runGo passes it.
vi.mock("../../scripts/trim-go-cache.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../scripts/trim-go-cache.js")>();
  return { trimGoCache: vi.fn(actual.trimGoCache) };
});

const ROOT = realpathSync(fileURLToPath(new URL("../..", import.meta.url)));
const TSX = packageBin("tsx", "tsx");
const PROJECT_CACHE = join("node_modules", ".cache", "go-build");

const HOUR = 60 * 60_000;
const GIB = 2 ** 30;

/** npm on Windows cannot run a shell-script `go`, and NTFS allocates sparse multi-GiB files. */
const POSIX = process.platform !== "win32";

const directories: string[] = [];

afterEach(() => {
  for (const dir of directories.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** A fresh temp directory, by its real path, removed after the test. */
function tempDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "ecstatic-go-wrapper-")));
  directories.push(dir);
  return dir;
}

/** A temp repository root holding copies of the wrapper and the trim in `scripts/`. */
function project(): string {
  const root = tempDir();
  mkdirSync(join(root, "scripts"));
  for (const name of ["go.ts", "trim-go-cache.ts"]) {
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

/** Writes a sparse `size`-byte cache entry in `bucket` of `cache`, last used `age` ago, and returns its path. */
function writeEntry(cache: string, bucket: string, size: number, age: number): string {
  const path = join(cache, bucket, `${bucket}${"1".repeat(62)}-a`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, "");
  truncateSync(path, size);
  const time = new Date(Date.now() - age);
  utimesSync(path, time, time);
  return path;
}

/** Whether each of `paths` still exists. */
function survivors(paths: readonly string[]): boolean[] {
  return paths.map((path) => existsSync(path));
}

/** A temp directory holding a shell-script `go` that runs `body`, for use on `PATH`. */
function fakeGo(body: string): string {
  const bin = tempDir();
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
  const record = join(tempDir(), "call");
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
    cwd: tempDir(),
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

    it.runIf(POSIX)("runs go and prints nothing when the project folder does not exist", () => {
      const root = project();
      const { bin, record } = recordingGo();

      const result = runWrapper(root, ["version"], environment(bin));

      expect(result.stderr).toBe("");
      expect(existsSync(record)).toBe(true);
    });
  });

  describe("when GOCACHE is set", () => {
    it.runIf(POSIX)("runs go with that GOCACHE and trims neither it nor the project folder", () => {
      const root = project();
      const cache = tempDir();
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

  describe("go's result", () => {
    it.runIf(POSIX)("passes go's stdout, stderr and exit code through unchanged", () => {
      const bin = fakeGo("echo out\necho err >&2\nexit 7");

      const result = runWrapper(project(), ["version"], environment(bin));

      expect({ status: result.status, stdout: result.stdout, stderr: result.stderr }).toStrictEqual(
        { status: 7, stdout: "out\n", stderr: "err\n" },
      );
    });

    it.runIf(POSIX)("exits non-zero when go is killed by a signal", () => {
      const bin = fakeGo("kill -KILL $$");

      const result = runWrapper(project(), ["version"], environment(bin));

      expect(result.status).not.toBe(0);
    });

    it("prints the error and exits non-zero when go cannot start", () => {
      const result = runWrapper(project(), ["version"], environment(tempDir()));

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("ENOENT");
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
      const cache = join(tempDir(), "go-build");
      const { bin, record } = recordingGo();

      const status = runGo(["version"], environment(bin, extra), cache);

      expect(vi.mocked(trimGoCache)).toHaveBeenCalledExactlyOnceWith(cache, {
        now: expect.any(Number),
        cap: 8 * GIB,
        target: 6 * GIB,
        protectedAge: 2 * HOUR,
      });
      expect({ status, call: readFileSync(record, "utf8") }).toStrictEqual({
        status: 0,
        call: `${cache}\nversion\n`,
      });
    },
  );
});

describe("runGo before go starts", () => {
  it.runIf(POSIX)("has already trimmed the project folder", () => {
    const cache = join(tempDir(), "go-build");
    const stale = writeEntry(cache, "00", 8 * GIB + 1, 5 * HOUR);
    const record = join(tempDir(), "call");
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
      const record = join(tempDir(), "calls");
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
