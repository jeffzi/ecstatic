import { execFileSync, spawnSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { afterEach, assert, describe, expect, it } from "vitest";

import { errorMessage } from "../../scripts/caught.js";
import { checkVersion, syncVersion } from "../../scripts/sync-version.js";
import { VERSION } from "../../src/index.js";

const TS_VERSION_FILE = join("src", "version.ts");
const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SUBPROCESS_TIMEOUT_MS = 60_000;

/** The files the `version` lifecycle script reads or rewrites, relative to the repository root. */
const VERSION_SCRIPT_FILES = [
  "package.json",
  join("scripts", "sync-version.ts"),
  join("scripts", "entry.ts"),
  TS_VERSION_FILE,
];

/** Creates a temp git repository holding copies of the files `npm version` needs, linked to this repository's node_modules, and returns its path. */
function createVersionRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "ecstatic-npm-version-"));
  for (const file of VERSION_SCRIPT_FILES) {
    cpSync(join(REPO_ROOT, file), join(dir, file));
  }
  symlinkSync(join(REPO_ROOT, "node_modules"), join(dir, "node_modules"));
  execFileSync("git", ["init", "--quiet"], { cwd: dir });
  return dir;
}

/** Writes a package.json declaring `version` into the project directory `dir`. */
function writePackageVersion(dir: string, version: string): void {
  writeFileSync(join(dir, "package.json"), JSON.stringify({ version }));
}

/** Creates a temp project directory holding a package.json with `version` and an empty src/, and returns its path. */
function createProject(version: string): string {
  const dir = join(
    tmpdir(),
    `ecstatic-version-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(join(dir, "src"), { recursive: true });
  writePackageVersion(dir, version);
  return dir;
}

/** The text of the generated src/version.ts inside the project directory `dir`. */
function readVersionFile(dir: string): string {
  return readFileSync(join(dir, TS_VERSION_FILE), "utf-8");
}

/** Registers an afterEach hook that removes every directory pushed onto the returned list. */
function trackTempDirs(): string[] {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  return dirs;
}

/** The `version` declared by this repository's package.json. */
function readRepoVersion(): string {
  const manifest: unknown = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf-8"));
  assert(
    typeof manifest === "object" &&
      manifest !== null &&
      "version" in manifest &&
      typeof manifest.version === "string",
  );
  return manifest.version;
}

/** The message of the error `action` throws; fails when it does not throw. */
function failureMessage(action: () => void): string {
  try {
    action();
  } catch (error) {
    return errorMessage(error);
  }
  throw new Error("expected the action to throw");
}

describe("VERSION", () => {
  it("equals the version in package.json", () => {
    expect(VERSION).toBe(readRepoVersion());
  });

  it("is a semver string", () => {
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });
});

describe("syncVersion", () => {
  it("writes src/version.ts as a generated module exporting VERSION", () => {
    const dir = createProject("1.2.3");
    syncVersion(dir);
    const content = readVersionFile(dir);

    expect(content).toMatch(/^\/\/ .*scripts\/sync-version\.ts/);
    expect(content).toContain('export const VERSION: string = "1.2.3"');
  });

  it("is idempotent — running twice yields byte-identical output", () => {
    const dir = createProject("2.0.0");

    syncVersion(dir);
    const first = readVersionFile(dir);

    syncVersion(dir);
    const second = readVersionFile(dir);

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

  it("fails naming src/version.ts and both versions when they differ", () => {
    const dir = createProject("1.0.0");
    syncVersion(dir);
    writePackageVersion(dir, "2.0.0");

    const message = failureMessage(() => {
      checkVersion(dir);
    });

    expect(message).toContain("src/version.ts");
    expect(message).toContain("1.0.0");
    expect(message).toContain("2.0.0");
  });

  it("fails with SyntaxError when package.json is not valid JSON", () => {
    const dir = createProject("1.0.0");
    syncVersion(dir);
    writeFileSync(join(dir, "package.json"), "{ version");

    expect(() => {
      checkVersion(dir);
    }).toThrow(SyntaxError);
  });

  it.each([
    { file: TS_VERSION_FILE, sync: false },
    { file: "package.json", sync: true },
  ])("fails with the filesystem error itself when $file cannot be read", ({ file, sync }) => {
    const dir = createProject("1.0.0");
    if (sync) syncVersion(dir);
    rmSync(join(dir, file), { force: true });

    expect(() => {
      checkVersion(dir);
    }).toThrow(expect.objectContaining({ code: "ENOENT", path: join(dir, file) }));
  });

  it("does not write when versions differ", () => {
    const dir = createProject("1.0.0");
    syncVersion(dir);
    const before = readVersionFile(dir);

    writePackageVersion(dir, "2.0.0");

    try {
      checkVersion(dir);
    } catch {
      // the mismatch error is not under test here; only the untouched file is asserted below
    }

    const after = readVersionFile(dir);
    expect(after).toBe(before);
  });
});

describe("npm version", () => {
  const repos = trackTempDirs();

  it(
    "stages a regenerated src/version.ts alone",
    () => {
      const dir = createVersionRepo();
      repos.push(dir);

      execFileSync("npm", ["version", "9.9.9", "--no-git-tag-version", "--ignore-scripts=false"], {
        cwd: dir,
        shell: process.platform === "win32",
        stdio: "pipe",
      });

      const staged = execFileSync("git", ["diff", "--cached", "--name-only"], {
        cwd: dir,
        encoding: "utf8",
      });
      expect(staged.split("\n").filter(Boolean)).toStrictEqual(["src/version.ts"]);
      expect(readVersionFile(dir)).toContain('export const VERSION: string = "9.9.9"');
    },
    SUBPROCESS_TIMEOUT_MS,
  );
});

describe("npm run check:version", () => {
  const repos = trackTempDirs();

  it(
    "fails naming src/version.ts and both versions, leaving the file as it was",
    () => {
      const dir = createVersionRepo();
      repos.push(dir);
      const manifest: unknown = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
      assert(typeof manifest === "object" && manifest !== null);
      writeFileSync(join(dir, "package.json"), JSON.stringify({ ...manifest, version: "9.9.9" }));
      const before = readVersionFile(dir);

      const result = spawnSync("npm", ["run", "--silent", "check:version"], {
        cwd: dir,
        encoding: "utf8",
        shell: process.platform === "win32",
      });

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(
        `src/version.ts has "${VERSION}" but package.json has "9.9.9"`,
      );
      expect(readVersionFile(dir)).toBe(before);
    },
    SUBPROCESS_TIMEOUT_MS,
  );
});

describe("isEntryScript", () => {
  const dirs = trackTempDirs();

  it(
    "counts only the script started through a symlinked directory as the entry",
    () => {
      const dir = mkdtempSync(join(tmpdir(), "ecstatic-entry-"));
      dirs.push(dir);
      const real = join(dir, "real");
      const linked = join(dir, "linked");
      mkdirSync(real);
      symlinkSync(real, linked, "dir");
      const entryUrl = pathToFileURL(join(REPO_ROOT, "scripts", "entry.ts")).href;
      writeFileSync(
        join(real, "imported.ts"),
        `import { isEntryScript } from ${JSON.stringify(entryUrl)};\nexport const importedIsEntry = isEntryScript(import.meta.url);\n`,
      );
      writeFileSync(
        join(real, "main.ts"),
        `import { isEntryScript } from ${JSON.stringify(entryUrl)};\nimport { importedIsEntry } from "./imported.ts";\nconsole.log(JSON.stringify({ main: isEntryScript(import.meta.url), imported: importedIsEntry }));\n`,
      );

      const result = spawnSync(
        join(REPO_ROOT, "node_modules", ".bin", "tsx"),
        [join(linked, "main.ts")],
        {
          cwd: dir,
          encoding: "utf8",
          shell: process.platform === "win32",
        },
      );

      expect({ stdout: result.stdout, stderr: result.stderr }).toStrictEqual({
        stdout: `${JSON.stringify({ main: true, imported: false })}\n`,
        stderr: "",
      });
    },
    SUBPROCESS_TIMEOUT_MS,
  );
});
