import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { checkVersion, syncVersion } from "../../scripts/sync-version.js";
import { VERSION } from "../../src/index.js";

/** Creates a temp project directory holding a package.json with `version` and an empty src/, and returns its path. */
function createProject(version: string): string {
  const dir = join(
    tmpdir(),
    `ecstatic-version-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ version }));
  return dir;
}

describe("VERSION", () => {
  it("equals the version in package.json", () => {
    const pkg = JSON.parse(
      readFileSync(new URL("../../package.json", import.meta.url), "utf-8"),
    ) as {
      version: string;
    };
    expect(VERSION).toBe(pkg.version);
  });

  it("is a semver string", () => {
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });
});

describe("syncVersion", () => {
  it("writes src/version.ts as a generated module exporting VERSION", () => {
    const dir = createProject("1.2.3");
    syncVersion(dir);
    const content = readFileSync(join(dir, "src", "version.ts"), "utf-8");

    expect(content).toMatch(/^\/\//);
    expect(content).toContain("sync-version");
    expect(content).toContain('export const VERSION: string = "1.2.3"');
  });

  it("is idempotent — running twice yields byte-identical output", () => {
    const dir = createProject("2.0.0");

    syncVersion(dir);
    const first = readFileSync(join(dir, "src", "version.ts"), "utf-8");

    syncVersion(dir);
    const second = readFileSync(join(dir, "src", "version.ts"), "utf-8");

    expect(second).toBe(first);
  });
});

describe("checkVersion", () => {
  it("succeeds when src/version.ts matches package.json", () => {
    const dir = createProject("1.0.0");
    syncVersion(dir);

    expect(() => {
      checkVersion(dir);
    }).not.toThrow();
  });

  it("fails with a message naming both versions when they differ", () => {
    const dir = createProject("1.0.0");
    syncVersion(dir);
    writeFileSync(join(dir, "package.json"), JSON.stringify({ version: "2.0.0" }));

    expect(() => {
      checkVersion(dir);
    }).toThrow(/1\.0\.0/);
    expect(() => {
      checkVersion(dir);
    }).toThrow(/2\.0\.0/);
  });

  it("does not write when versions differ", () => {
    const dir = createProject("1.0.0");
    syncVersion(dir);
    const before = readFileSync(join(dir, "src", "version.ts"), "utf-8");

    writeFileSync(join(dir, "package.json"), JSON.stringify({ version: "2.0.0" }));

    try {
      checkVersion(dir);
    } catch {
      // the mismatch error is not under test here; only the untouched file is asserted below
    }

    const after = readFileSync(join(dir, "src", "version.ts"), "utf-8");
    expect(after).toBe(before);
  });
});
