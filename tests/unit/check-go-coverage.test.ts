import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { errorMessage } from "../../scripts/caught.js";
import { checkGoCoverage } from "../../scripts/check-go-coverage.js";
import { packageBin } from "../package-bin.js";

const MODULE = "github.com/jeffzi/ecstatic/optimizer";
const SCRIPT = fileURLToPath(new URL("../../scripts/check-go-coverage.ts", import.meta.url));
const TSX = packageBin("tsx", "tsx");

const directories: string[] = [];

afterEach(() => {
  for (const dir of directories.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** One file's coverage in package `pkg` (`""` for the module root): `covered` of `total` statements executed. */
interface PackageCoverage {
  readonly pkg: string;
  readonly file?: string;
  readonly covered: number;
  readonly total: number;
}

/** Profile lines for one file: one covered block and one uncovered block. */
function blockLines({ pkg, file = "code.go", covered, total }: PackageCoverage): string[] {
  const path = pkg === "" ? `${MODULE}/${file}` : `${MODULE}/${pkg}/${file}`;
  return [`${path}:1.1,2.2 ${covered} 1`, `${path}:3.1,4.2 ${total - covered} 0`];
}

/** Writes a `go test -coverprofile` file holding `content` at `relative` in a fresh temp directory and returns its path. */
function writeProfile(content: string, relative = "go.out"): string {
  const dir = mkdtempSync(join(tmpdir(), "ecstatic-go-coverage-"));
  directories.push(dir);
  const path = join(dir, relative);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  return path;
}

/** The text of a `mode: set` profile covering `packages`. */
function coverageProfile(...packages: PackageCoverage[]): string {
  return ["mode: set", ...packages.flatMap(blockLines), ""].join("\n");
}

/** Writes a `mode: set` profile covering `packages` and returns its path. */
function writeCoverage(...packages: PackageCoverage[]): string {
  return writeProfile(coverageProfile(...packages));
}

/** Runs scripts/check-go-coverage.ts as a command in `cwd` with `args`. */
function runScript(cwd: string, args: readonly string[]): SpawnSyncReturns<string> {
  return spawnSync(process.execPath, [TSX, SCRIPT, ...args], { cwd, encoding: "utf8" });
}

/** The message `checkGoCoverage(path)` throws, or `undefined` when it returns. */
function failureMessage(path: string): string | undefined {
  try {
    checkGoCoverage(path);
  } catch (error) {
    return errorMessage(error);
  }
  return undefined;
}

describe("checkGoCoverage", () => {
  describe("when every package reaches 95% statement coverage", () => {
    it.each([
      { name: "exactly 95%", covered: 19, total: 20 },
      { name: "full coverage", covered: 7, total: 7 },
    ])("returns for $name", ({ covered, total }) => {
      const path = writeCoverage({ pkg: "facts", covered, total });

      expect(() => {
        checkGoCoverage(path);
      }).not.toThrow();
    });
  });

  describe("when packages fall below 95% statement coverage", () => {
    it("throws naming each failing package and none of the passing ones", () => {
      const path = writeCoverage(
        { pkg: "facts", covered: 18, total: 20 },
        { pkg: "internal/importcheck", covered: 20, total: 20 },
        { pkg: "plan", covered: 0, total: 4 },
      );

      const message = failureMessage(path);

      expect(message).toContain(`${MODULE}/facts`);
      expect(message).toContain(`${MODULE}/plan`);
      expect(message).not.toContain("importcheck");
    });
  });

  describe("when the only uncovered statements are in a main.go", () => {
    it.each([
      {
        name: "the module root, whose only file is main.go",
        files: [{ pkg: "", file: "main.go", covered: 0, total: 10 }],
      },
      {
        name: "a package whose other files are covered",
        files: [
          { pkg: "plugin", file: "main.go", covered: 0, total: 10 },
          { pkg: "plugin", covered: 5, total: 5 },
        ],
      },
    ])("returns for $name", ({ files }) => {
      const path = writeCoverage(...files, { pkg: "facts", covered: 5, total: 5 });

      expect(() => {
        checkGoCoverage(path);
      }).not.toThrow();
    });
  });

  describe("when a file other than main.go under cmd/ is uncovered", () => {
    it.each(["code.go", "domain.go"])("throws naming its package for %s", (file) => {
      const path = writeCoverage(
        { pkg: "cmd/ecstatic-optimizer", file: "main.go", covered: 4, total: 4 },
        { pkg: "cmd/ecstatic-optimizer", file, covered: 0, total: 10 },
      );

      expect(() => {
        checkGoCoverage(path);
      }).toThrow(`${MODULE}/cmd/ecstatic-optimizer`);
    });
  });

  describe("when a package has no statements", () => {
    it("passes it", () => {
      const path = writeCoverage({ pkg: "version", covered: 0, total: 0 });

      expect(() => {
        checkGoCoverage(path);
      }).not.toThrow();
    });
  });

  describe("when the profile is missing", () => {
    it("throws naming the file", () => {
      const path = join(dirname(writeCoverage()), "absent.out");

      expect(() => {
        checkGoCoverage(path);
      }).toThrow(path);
    });
  });

  describe("when the profile cannot be parsed", () => {
    it.each([
      { name: "an empty file", content: "" },
      { name: "no mode line", content: `${MODULE}/facts/code.go:1.1,2.2 1 1\n` },
      { name: "a malformed block line", content: "mode: set\nbanana\n" },
    ])("throws naming the file for $name", ({ content }) => {
      const path = writeProfile(content);

      expect(() => {
        checkGoCoverage(path);
      }).toThrow(path);
    });
  });

  describe("when the profile holds blank lines", () => {
    it.each([
      {
        name: "a malformed block line after a blank line, naming its file line",
        content: `mode: set\n\n${blockLines({ pkg: "facts", covered: 5, total: 5 })[0]}\nbanana\n`,
        expected: (path: string) => `${path}:4 is not a coverage block: banana`,
      },
      {
        name: "a blank line before the mode line",
        content: `\n${coverageProfile({ pkg: "facts", covered: 5, total: 5 })}`,
        expected: (path: string) =>
          `${path} is not a Go coverage profile: the first line is not "mode: …"`,
      },
    ])("throws for $name", ({ content, expected }) => {
      const path = writeProfile(content);

      expect(failureMessage(path)).toBe(expected(path));
    });
  });
});

describe("scripts/check-go-coverage.ts run as a command", () => {
  it("exits non-zero naming the failing package for a failing profile argument", () => {
    const path = writeCoverage({ pkg: "plan", covered: 0, total: 4 });

    const result = runScript(dirname(path), [path]);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(`${MODULE}/plan`);
  });

  it("exits 0 for a passing profile argument", () => {
    const path = writeCoverage({ pkg: "facts", covered: 5, total: 5 });

    const result = runScript(dirname(path), [path]);

    expect(result.status).toBe(0);
  });

  it("reads coverage/go.out in the working directory when given no argument", () => {
    const path = writeProfile(
      coverageProfile({ pkg: "plan", covered: 0, total: 4 }),
      join("coverage", "go.out"),
    );

    const result = runScript(dirname(dirname(path)), []);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(`${MODULE}/plan`);
  });
});
