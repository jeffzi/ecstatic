import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  truncateSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";

import { trimGoCache } from "../../scripts/trim-go-cache.js";

/** Paths another process removes just before the trim lists or deletes them. */
const racing = vi.hoisted(() => new Set<string>());

// node:fs is the boundary to a cache other processes change under the trim. A path in `racing` is
// removed right before the trim's own listing or deletion of it, which is the only way to land in
// the window between the trim's stat of a path and its next call on it.
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const removeIfRacing = (path: unknown): void => {
    if (typeof path === "string" && racing.delete(path)) actual.rmSync(path, { recursive: true });
  };
  return {
    ...actual,
    readdirSync: (...args: Parameters<typeof actual.readdirSync>) => {
      removeIfRacing(args[0]);
      return actual.readdirSync(...args);
    },
    rmSync: (...args: Parameters<typeof actual.rmSync>) => {
      removeIfRacing(args[0]);
      actual.rmSync(...args);
    },
  };
});

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const MIB = 2 ** 20;
const GIB = 2 ** 30;
const TIB = 2 ** 40;
const NOW = Date.UTC(2026, 9, 19, 12, 0, 0);
const PROTECTED_AGE = 2 * HOUR;

/** Permission bits only take effect on POSIX systems, and never for root. */
const PERMISSIONS_ENFORCED = process.platform !== "win32" && process.getuid?.() !== 0;
/**
 * Unprivileged Windows accounts cannot create symbolic links, and NTFS allocates the gigabytes a
 * sparse file of that size would leave unallocated.
 */
const POSIX = process.platform !== "win32";

const directories: string[] = [];
const lockedDirectories: string[] = [];

let stderr: MockInstance<typeof process.stderr.write>;

beforeEach(() => {
  stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});

afterEach(() => {
  vi.restoreAllMocks();
  racing.clear();
  for (const dir of lockedDirectories.splice(0)) {
    chmodSync(dir, 0o755);
  }
  for (const dir of directories.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** A fresh temp directory removed after the test. */
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ecstatic-go-cache-"));
  directories.push(dir);
  return dir;
}

/** Sets the permission bits of `dir` to `mode`; `afterEach` restores them before cleanup. */
function lockDir(dir: string, mode: number): void {
  chmodSync(dir, mode);
  lockedDirectories.push(dir);
}

/** Sets the mtime of `path` to `age` milliseconds before `now`. */
function setAge(path: string, age: number, now = NOW): void {
  const time = new Date(now - age);
  utimesSync(path, time, time);
}

/** The path of entry number `seed` of `kind` in bucket `bucket` of `cache`. */
function entryPath(cache: string, bucket: string, seed: number, kind: "a" | "d"): string {
  return join(cache, bucket, `${bucket}${seed.toString(16).padStart(62, "0")}-${kind}`);
}

/** Writes a sparse `size`-byte file at `path`, creating parent directories, with an mtime `age` before `NOW`. */
function writeSized(path: string, size: number, age: number): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, "");
  truncateSync(path, size);
  setAge(path, age);
  return path;
}

/** Writes a `-a` entry of `size` bytes in `bucket`, last used `age` before `NOW`, and returns its path. */
function writeEntry(cache: string, bucket: string, size: number, age: number): string {
  return writeSized(entryPath(cache, bucket, 1, "a"), size, age);
}

/** Writes a `-d` directory in `bucket` holding one file per size (each fresh), with the directory itself `age` old. */
function writeOutputDir(
  cache: string,
  bucket: string,
  sizes: readonly number[],
  age: number,
): string {
  const dir = entryPath(cache, bucket, 1, "d");
  mkdirSync(dir, { recursive: true });
  for (const [index, size] of sizes.entries()) {
    writeSized(join(dir, `file${index}`), size, 0);
  }
  setAge(dir, age);
  return dir;
}

/** Runs `trimGoCache` over `cache` at `NOW` with a 2 h protection window and the given limits. */
function trim(
  cache: string,
  limits: { cap: number; target: number },
  beforeDelete?: (path: string) => void,
): void {
  trimGoCache(cache, {
    now: NOW,
    cap: limits.cap,
    target: limits.target,
    protectedAge: PROTECTED_AGE,
    ...(beforeDelete === undefined ? {} : { beforeDelete }),
  });
}

/** Whether each of `paths` still exists. */
function survivors(paths: readonly string[]): boolean[] {
  return paths.map((path) => existsSync(path));
}

describe("trimGoCache", () => {
  describe("when the entries total no more than the cap", () => {
    it("deletes nothing", () => {
      const cache = tempDir();
      const entries = [
        writeEntry(cache, "00", 100, 5 * HOUR),
        writeEntry(cache, "01", 100, 3 * HOUR),
      ];

      trim(cache, { cap: 200, target: 100 });

      expect(survivors(entries)).toStrictEqual([true, true]);
    });
  });

  describe("when the entries total more than the cap", () => {
    it("deletes the oldest entries until the total reaches the target, and no more", () => {
      const cache = tempDir();
      const entries = [
        writeEntry(cache, "ff", 100, 5 * HOUR),
        writeEntry(cache, "0a", 100, 4 * HOUR),
        writeEntry(cache, "00", 100, 3 * HOUR),
        writeEntry(cache, "80", 100, 2.5 * HOUR),
      ];

      trim(cache, { cap: 350, target: 200 });

      expect(survivors(entries)).toStrictEqual([false, false, true, true]);
    });

    it("does not create trim.txt", () => {
      const cache = tempDir();
      writeEntry(cache, "00", 100, 5 * HOUR);

      trim(cache, { cap: 50, target: 0 });

      expect(existsSync(join(cache, "trim.txt"))).toBe(false);
    });
  });

  describe("when entries were used within the protection window", () => {
    it.each([
      {
        rule: "and deletes the rest oldest first",
        sizes: [300, 300, 300, 300],
        ages: [10 * MINUTE, 20 * MINUTE, 30 * MINUTE, 3 * HOUR],
        limits: { cap: 1000, target: 600 },
        expected: [true, true, false, false],
      },
      {
        rule: "stopping at the first that would pass it even when an older one fits",
        sizes: [300, 400, 100],
        ages: [10 * MINUTE, 20 * MINUTE, 30 * MINUTE],
        limits: { cap: 700, target: 600 },
        expected: [true, false, false],
      },
    ])(
      "spares the newest of them while their total stays within the target, $rule",
      ({ sizes, ages, limits, expected }) => {
        const cache = tempDir();
        const entries = sizes.map((size, index) =>
          writeEntry(cache, `0${index}`, size, ages[index] ?? 0),
        );

        trim(cache, limits);

        expect(survivors(entries)).toStrictEqual(expected);
      },
    );

    it.each([
      {
        seen: "outside the window",
        ages: [4 * HOUR, 3 * HOUR, 2.5 * HOUR],
        target: 200,
      },
      {
        seen: "as a recent entry beyond the protected share",
        ages: [30 * MINUTE, 20 * MINUTE, 10 * MINUTE],
        target: 100,
      },
    ])(
      "spares an entry a build refreshed after the scan saw it $seen and deletes the next oldest instead",
      ({ ages, target }) => {
        const cache = tempDir();
        const entries = ages.map((age, index) => writeEntry(cache, `0${index}`, 100, age));
        const [refreshed] = entries;

        trim(cache, { cap: 250, target }, (path) => {
          if (path === refreshed) setAge(path, MINUTE);
        });

        expect(survivors(entries)).toStrictEqual([true, false, true]);
        expect(stderr.mock.calls).toStrictEqual([
          ["Trimmed the Go build cache from 300 B to 200 B by removing 1 entry\n"],
        ]);
      },
    );

    it("counts an entry exactly the protection window old as outside it", () => {
      const cache = tempDir();
      const entries = [3 * HOUR, PROTECTED_AGE, 10 * MINUTE].map((age, index) =>
        writeEntry(cache, `0${index}`, 100, age),
      );
      const [refreshed] = entries;

      trim(cache, { cap: 250, target: 200 }, (path) => {
        if (path === refreshed) setAge(path, MINUTE);
      });

      expect(survivors(entries)).toStrictEqual([true, false, true]);
    });
  });

  describe("when the cache holds files other than entries", () => {
    it("neither counts nor deletes them", () => {
      const cache = tempDir();
      const hex = "1".repeat(64);
      const others = [
        "README",
        "trim.txt",
        "testexpire.txt",
        "0a",
        join("fuzz", `${hex}-a`),
        join("zz", `${hex}-a`),
        join("abc", `${hex}-a`),
        join("00", `${"1".repeat(63)}-a`),
        join("00", `${"1".repeat(65)}-a`),
        join("00", `${"A".repeat(64)}-a`),
        join("AB", `${hex}-a`),
        join("00", `${hex}-b`),
        join("00", `${hex}-a.tmp`),
        join("00", "nested", `${hex}-a`),
      ].map((relative) => writeSized(join(cache, relative), 1000, 10 * HOUR));
      const contents = others.map((path) => readFileSync(path));
      const entries = [
        writeEntry(cache, "01", 100, 5 * HOUR),
        writeEntry(cache, "02", 100, 4 * HOUR),
      ];

      trim(cache, { cap: 150, target: 100 });

      expect(survivors(entries)).toStrictEqual([false, true]);
      expect(others.map((path) => readFileSync(path))).toStrictEqual(contents);
    });
  });

  describe("when an entry is a -d directory", () => {
    it("counts the files inside it and removes it whole, judged by its own mtime", () => {
      const cache = tempDir();
      const entries = [
        writeOutputDir(cache, "00", [600, 400], 6 * HOUR),
        writeEntry(cache, "01", 100, 5 * HOUR),
        writeEntry(cache, "02", 100, 4 * HOUR),
      ];

      trim(cache, { cap: 1150, target: 1100 });

      expect(survivors(entries)).toStrictEqual([false, true, true]);
    });

    it("leaves the files in its subdirectories out of its size", () => {
      const cache = tempDir();
      const outputDir = writeOutputDir(cache, "00", [100], 6 * HOUR);
      writeSized(join(outputDir, "nested", "file"), 1000, 0);
      setAge(outputDir, 6 * HOUR);
      const entries = [
        outputDir,
        writeEntry(cache, "01", 100, 5 * HOUR),
        writeEntry(cache, "02", 100, 4 * HOUR),
      ];

      trim(cache, { cap: 300, target: 100 });

      expect(survivors(entries)).toStrictEqual([true, true, true]);
    });

    it("counts an empty one as zero bytes", () => {
      const cache = tempDir();
      const entries = [
        writeOutputDir(cache, "00", [], 6 * HOUR),
        writeEntry(cache, "01", 100, 5 * HOUR),
        writeEntry(cache, "02", 100, 4 * HOUR),
      ];

      trim(cache, { cap: 200, target: 100 });

      expect(survivors(entries)).toStrictEqual([true, true, true]);
    });
  });

  describe("when something is gone by the time the trim reads it", () => {
    it.runIf(POSIX)("leaves a vanished bucket, entry, or -d file out of the total", () => {
      const cache = tempDir();
      const missing = join(cache, "x".repeat(200));
      const outputDir = writeOutputDir(cache, "00", [], 6 * HOUR);
      symlinkSync(missing, join(outputDir, "file0"));
      setAge(outputDir, 6 * HOUR);
      mkdirSync(join(cache, "01"));
      symlinkSync(missing, entryPath(cache, "01", 2, "a"));
      symlinkSync(missing, join(cache, "02"));
      const entries = [
        outputDir,
        writeEntry(cache, "03", 100, 5 * HOUR),
        writeEntry(cache, "04", 100, 4 * HOUR),
      ];

      trim(cache, { cap: 200, target: 100 });

      expect(survivors(entries)).toStrictEqual([true, true, true]);
    });

    it.each([
      {
        moment: "re-read",
        vanish: (entry: string) => (path: string) => {
          if (path === entry) rmSync(path);
        },
      },
      {
        moment: "delete",
        vanish: (entry: string) => {
          racing.add(entry);
          return undefined;
        },
      },
    ])("counts an entry gone at its $moment as freed but not as removed", ({ vanish }) => {
      const cache = tempDir();
      const beforeDelete = vanish(writeEntry(cache, "00", 100, 5 * HOUR));
      const entries = [
        writeEntry(cache, "01", 100, 4 * HOUR),
        writeEntry(cache, "02", 100, 3 * HOUR),
        writeEntry(cache, "03", 100, 2.5 * HOUR),
      ];

      trim(cache, { cap: 350, target: 200 }, beforeDelete);

      expect(survivors(entries)).toStrictEqual([false, true, true]);
      expect(stderr.mock.calls).toStrictEqual([
        ["Trimmed the Go build cache from 400 B to 200 B by removing 1 entry\n"],
      ]);
    });

    it.each([
      {
        name: "a bucket",
        vanishing: (cache: string) => dirname(writeEntry(cache, "00", 1000, 6 * HOUR)),
      },
      {
        name: "a -d directory",
        vanishing: (cache: string) => writeOutputDir(cache, "00", [1000], 6 * HOUR),
      },
    ])(
      "leaves $name removed between its stat and its listing out of the total",
      ({ vanishing }) => {
        const cache = tempDir();
        racing.add(vanishing(cache));
        const entries = [
          writeEntry(cache, "01", 100, 5 * HOUR),
          writeEntry(cache, "02", 100, 4 * HOUR),
        ];

        trim(cache, { cap: 250, target: 100 });

        expect(survivors(entries)).toStrictEqual([true, true]);
      },
    );
  });

  describe("when reading or deleting fails for another reason", () => {
    it("throws naming the cache path when it is not a directory", () => {
      const cache = writeSized(join(tempDir(), "cache"), 10, 0);

      expect(() => {
        trim(cache, { cap: 0, target: 0 });
      }).toThrow(cache);
    });

    it.runIf(PERMISSIONS_ENFORCED)("throws naming a bucket it cannot read", () => {
      const cache = tempDir();
      const bucket = dirname(writeEntry(cache, "00", 100, 5 * HOUR));
      lockDir(bucket, 0o000);

      expect(() => {
        trim(cache, { cap: 50, target: 0 });
      }).toThrow(bucket);
    });

    it.runIf(PERMISSIONS_ENFORCED)("throws naming an entry it cannot stat", () => {
      const cache = tempDir();
      const entry = writeEntry(cache, "00", 100, 5 * HOUR);
      lockDir(dirname(entry), 0o444);

      expect(() => {
        trim(cache, { cap: 50, target: 0 });
      }).toThrow(entry);
    });

    it.runIf(PERMISSIONS_ENFORCED)("throws naming an entry it cannot delete", () => {
      const cache = tempDir();
      const entry = writeEntry(cache, "00", 100, 5 * HOUR);
      lockDir(dirname(entry), 0o555);

      expect(() => {
        trim(cache, { cap: 50, target: 0 });
      }).toThrow(entry);
    });

    it.runIf(PERMISSIONS_ENFORCED)("throws naming a -d directory it cannot list", () => {
      const cache = tempDir();
      const outputDir = writeOutputDir(cache, "00", [100], 5 * HOUR);
      lockDir(outputDir, 0o000);

      expect(() => {
        trim(cache, { cap: 50, target: 0 });
      }).toThrow(outputDir);
    });

    it.runIf(PERMISSIONS_ENFORCED)("throws naming a file in a -d directory it cannot stat", () => {
      const cache = tempDir();
      const outputDir = writeOutputDir(cache, "00", [100], 5 * HOUR);
      lockDir(outputDir, 0o444);

      expect(() => {
        trim(cache, { cap: 50, target: 0 });
      }).toThrow(join(outputDir, "file0"));
    });

    it.runIf(PERMISSIONS_ENFORCED)(
      "throws naming an entry it cannot stat again before deleting it",
      () => {
        const cache = tempDir();
        const entry = writeEntry(cache, "00", 100, 5 * HOUR);

        expect(() => {
          trim(cache, { cap: 50, target: 0 }, (path) => {
            lockDir(dirname(path), 0o444);
          });
        }).toThrow(entry);
      },
    );
  });

  describe("when the cache directory does not exist", () => {
    it("deletes nothing and does not create it", () => {
      const cache = join(tempDir(), "absent");

      trim(cache, { cap: 0, target: 0 });

      expect(existsSync(cache)).toBe(false);
    });
  });

  describe("reporting", () => {
    it.each([
      { size: 100, before: "400 B", after: "200 B" },
      { size: 1.5 * 2 ** 10, before: "6.0 KiB", after: "3.0 KiB" },
      { size: 1.5 * MIB, before: "6.0 MiB", after: "3.0 MiB" },
      ...(POSIX
        ? [
            { size: 1.5 * GIB, before: "6.0 GiB", after: "3.0 GiB" },
            { size: 1.5 * TIB, before: "6.0 TiB", after: "3.0 TiB" },
          ]
        : []),
    ])("prints one stderr line with $before before and $after after", ({ size, before, after }) => {
      const cache = tempDir();
      writeEntry(cache, "00", size, 5 * HOUR);
      writeEntry(cache, "01", size, 4 * HOUR);
      writeEntry(cache, "02", size, 3 * HOUR);
      writeEntry(cache, "03", size, 2.5 * HOUR);

      trim(cache, { cap: 3.5 * size, target: 2 * size });

      expect(stderr.mock.calls).toStrictEqual([
        [`Trimmed the Go build cache from ${before} to ${after} by removing 2 entries\n`],
      ]);
    });

    it.each([
      { when: "under the cap", cap: 100, beforeDelete: undefined },
      {
        when: "over the cap with its only candidate refreshed by a build",
        cap: 50,
        beforeDelete: (path: string) => {
          setAge(path, MINUTE);
        },
      },
    ])("prints nothing when it deletes nothing $when", ({ cap, beforeDelete }) => {
      const cache = tempDir();
      writeEntry(cache, "00", 100, 5 * HOUR);

      trim(cache, { cap, target: 0 }, beforeDelete);

      expect(stderr.mock.calls).toStrictEqual([]);
    });
  });
});
