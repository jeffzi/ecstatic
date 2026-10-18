import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { pathToFileURL } from "node:url";

import { afterAll, afterEach, assert, beforeAll, describe, expect, it } from "vitest";

import { assertPluginEntry } from "../../../src/plugin/plugin-entry.js";
import { packageBin } from "../../package-bin.js";
import {
  createProject,
  createTempDir,
  DESCRIPTOR_SOURCE,
  ECSTATIC_ENTRY,
  OTHER_ENTRY,
  REPO_ROOT,
  removeTempDirs,
  withPlugins,
  writeFixtures,
} from "./tsconfig-fixtures.js";

const BUILD_TIMEOUT_MS = 120_000;
const TSC = packageBin("typescript", "tsc");
const MENTIONS_EXTENDS = /\bextends\b/;
const MENTIONS_OBJECT = /\bobject\b/;

/** A tsconfig naming the descriptor by its package subpath, written as JSONC with comments and trailing commas. */
const JSONC_TSCONFIG = `{
  // the transform plugins ttsc runs
  "compilerOptions": {
    /* ecstatic first */
    "plugins": [{ "transform": "ecstatic/optimizer", },],
  },
}
`;

/** Narrows a dynamically imported plugin-entry module to its `assertPluginEntry` export. */
function assertPluginEntryOf(module: unknown): (tsconfig: string) => void {
  assert(typeof module === "object" && module !== null && "assertPluginEntry" in module);
  const { assertPluginEntry: exported } = module;
  assert(typeof exported === "function");
  return (tsconfig) => {
    exported(tsconfig);
  };
}

afterEach(removeTempDirs);

/** A path to the descriptor source, written relative to `dir`. */
function descriptorFrom(dir: string): string {
  const path = relative(dir, DESCRIPTOR_SOURCE);
  if (!isAbsolute(path)) return path;
  // No relative path crosses Windows drives, as from a temp directory on C: to a checkout on D:,
  // so the path names a link to the descriptor inside `dir` instead.
  mkdirSync(dir, { recursive: true });
  symlinkSync(DESCRIPTOR_SOURCE, join(dir, "optimizer.ts"));
  return "./optimizer.ts";
}

/** A pattern matching any of `paths` literally. */
function anyOf(paths: readonly string[]): RegExp {
  return new RegExp(paths.map((path) => path.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"));
}

/** The error `act` throws; fails the test when it returns. */
function thrownBy(act: () => void): Error {
  try {
    act();
  } catch (error) {
    assert(error instanceof Error, "expected an Error instance");
    return error;
  }
  throw new Error("expected the call to throw");
}

/** Writes `files` into a fresh temp directory and returns the path of its `tsconfig.json`. */
function createConfigs(files: (dir: string) => Record<string, unknown>): string {
  const dir = createTempDir();
  writeFixtures(dir, files(dir));
  return join(dir, "tsconfig.json");
}

describe("assertPluginEntry", () => {
  describe("when an effective plugin entry is the ecstatic descriptor", () => {
    it.each([
      {
        kind: "by its package subpath",
        files: () => ({ "tsconfig.json": withPlugins(ECSTATIC_ENTRY) }),
      },
      {
        kind: "after another plugin",
        files: () => ({ "tsconfig.json": withPlugins(OTHER_ENTRY, ECSTATIC_ENTRY) }),
      },
      {
        kind: "by a relative path to its source",
        files: (dir: string) => ({
          "tsconfig.json": withPlugins({ transform: descriptorFrom(dir) }),
        }),
      },
      {
        kind: "by a relative path without its extension",
        files: (dir: string) => ({
          "tsconfig.json": withPlugins({ transform: descriptorFrom(dir).replace(/\.ts$/, "") }),
        }),
      },
      {
        kind: "inherited through extends",
        files: () => ({
          "tsconfig.json": { extends: "./base.json" },
          "base.json": withPlugins(ECSTATIC_ENTRY),
        }),
      },
      {
        kind: "inherited past a config declaring other compiler options",
        files: () => ({
          "tsconfig.json": { extends: "./middle.json" },
          "middle.json": { extends: "./base.json", compilerOptions: { strict: true } },
          "base.json": withPlugins(ECSTATIC_ENTRY),
        }),
      },
      {
        kind: "by a path relative to the inherited config declaring it",
        files: (dir: string) => ({
          "tsconfig.json": { extends: "./shared/base.json" },
          "shared/base.json": withPlugins({ transform: descriptorFrom(join(dir, "shared")) }),
        }),
      },
      {
        kind: "inherited through two extends entries sharing a base",
        files: () => ({
          "tsconfig.json": { extends: ["./a.json", "./b.json"] },
          "a.json": { extends: "./base.json" },
          "b.json": { extends: "./base.json" },
          "base.json": withPlugins(ECSTATIC_ENTRY),
        }),
      },
      {
        kind: "in a tsconfig written as JSONC",
        files: () => ({ "tsconfig.json": JSONC_TSCONFIG }),
      },
      {
        kind: "inherited through a package extends",
        files: () => ({
          "tsconfig.json": { extends: "@banana/base/tsconfig.json" },
          "node_modules/@banana/base/package.json": { name: "@banana/base" },
          "node_modules/@banana/base/tsconfig.json": withPlugins(ECSTATIC_ENTRY),
        }),
      },
      {
        kind: "with enabled set to true",
        files: () => ({ "tsconfig.json": withPlugins({ ...ECSTATIC_ENTRY, enabled: true }) }),
      },
      {
        kind: "from the last extends entry declaring plugins",
        files: () => ({
          "tsconfig.json": { extends: ["./other.json", "./ecstatic.json"] },
          "other.json": withPlugins(OTHER_ENTRY),
          "ecstatic.json": withPlugins(ECSTATIC_ENTRY),
        }),
      },
      {
        kind: "through a symlink to its source",
        files: (dir: string) => {
          symlinkSync(DESCRIPTOR_SOURCE, join(dir, "linked.ts"));
          return { "tsconfig.json": withPlugins({ transform: "./linked.ts" }) };
        },
      },
    ])("accepts the tsconfig naming it $kind", ({ files }) => {
      const tsconfig = createConfigs(files);

      expect(() => {
        assertPluginEntry(tsconfig);
      }).not.toThrow();
    });
  });

  describe("when loaded from the built package", () => {
    let packageDir = "";
    let assertBuiltPluginEntry: (tsconfig: string) => void = () => {
      throw new Error("the built package was not loaded");
    };

    /** The path of `file` under the built package's `dist/plugin/`. */
    function builtPlugin(file: string): string {
      return join(packageDir, "dist", "plugin", file);
    }

    beforeAll(async () => {
      packageDir = mkdtempSync(join(realpathSync(tmpdir()), "ecstatic-package-"));
      execFileSync(
        process.execPath,
        [TSC, "-p", "tsconfig.build-plugin.json", "--outDir", join(packageDir, "dist")],
        { cwd: REPO_ROOT, stdio: "pipe" },
      );
      copyFileSync(join(REPO_ROOT, "package.json"), join(packageDir, "package.json"));
      symlinkSync(join(REPO_ROOT, "node_modules"), join(packageDir, "node_modules"));
      const builtEntry = builtPlugin("plugin-entry.js");
      assertBuiltPluginEntry = assertPluginEntryOf(await import(pathToFileURL(builtEntry).href));
    }, BUILD_TIMEOUT_MS);

    afterAll(() => {
      rmSync(packageDir, { recursive: true, force: true });
    });

    it.each([
      { kind: "the built descriptor", target: () => builtPlugin("optimizer.js") },
      {
        kind: "the built descriptor without its extension",
        target: () => builtPlugin("optimizer"),
      },
      {
        kind: "a symlink to the built descriptor without its extension",
        target: (dir: string) => {
          symlinkSync(builtPlugin("optimizer.js"), join(dir, "optimizer.js"));
          return join(dir, "optimizer");
        },
      },
    ])("accepts the tsconfig naming $kind by relative path", ({ target }) => {
      const tsconfig = createConfigs((dir) => ({
        "tsconfig.json": withPlugins({ transform: `./${relative(dir, target(dir))}` }),
      }));

      expect(() => {
        assertBuiltPluginEntry(tsconfig);
      }).not.toThrow();
    });
  });

  describe("when no effective plugin entry is the ecstatic descriptor", () => {
    it.each([
      { kind: "declares no compiler options", files: () => ({ "tsconfig.json": {} }) },
      { kind: "declares an empty plugin list", files: () => ({ "tsconfig.json": withPlugins() }) },
      {
        kind: "lists only another plugin",
        files: () => ({ "tsconfig.json": withPlugins(OTHER_ENTRY) }),
      },
      {
        kind: "disables the ecstatic entry",
        files: () => ({ "tsconfig.json": withPlugins({ ...ECSTATIC_ENTRY, enabled: false }) }),
      },
      {
        kind: "names a sibling ecstatic subpath",
        files: () => ({ "tsconfig.json": withPlugins({ transform: "ecstatic/ttsc" }) }),
      },
      {
        kind: "names a different file by relative path",
        files: () => ({
          "tsconfig.json": withPlugins({ transform: "./optimizer.ts" }),
          "optimizer.ts": "export default {};\n",
        }),
      },
      {
        kind: "replaces an inherited ecstatic entry with its own list",
        files: () => ({
          "tsconfig.json": { extends: "./base.json", ...withPlugins(OTHER_ENTRY) },
          "base.json": withPlugins(ECSTATIC_ENTRY),
        }),
      },
      {
        kind: "inherits from a later extends entry that overrides the ecstatic one",
        files: () => ({
          "tsconfig.json": { extends: ["./ecstatic.json", "./other.json"] },
          "ecstatic.json": withPlugins(ECSTATIC_ENTRY),
          "other.json": withPlugins(OTHER_ENTRY),
        }),
      },
      {
        kind: "inherits a relative path written for another directory",
        files: (dir: string) => ({
          "tsconfig.json": { extends: "./shared/base.json" },
          "shared/base.json": withPlugins({ transform: descriptorFrom(dir) }),
        }),
      },
    ])("throws naming the tsconfig that $kind", ({ files }) => {
      const tsconfig = createConfigs(files);

      const error = thrownBy(() => {
        assertPluginEntry(tsconfig);
      });

      expect(error.message).toContain(tsconfig);
      expect(error.message).toMatch(/\bpass `project`/);
      expect(error.message).toContain('{ "transform": "ecstatic/optimizer" }');
    });
  });

  describe("when a tsconfig in the chain cannot be read", () => {
    it.each([
      { kind: "a missing tsconfig", files: {}, named: "tsconfig.json" },
      {
        kind: "a tsconfig path that is a directory",
        files: {},
        named: "tsconfig.json",
        prepare: (dir: string) => {
          mkdirSync(join(dir, "tsconfig.json"));
        },
      },
      {
        kind: "a tsconfig that is not valid JSONC",
        files: { "tsconfig.json": '{ "compilerOptions": ' },
        named: "tsconfig.json",
      },
      {
        kind: "an extended config that is not valid JSONC",
        files: { "tsconfig.json": { extends: "./base.json" }, "base.json": "{ plugins }" },
        named: "base.json",
      },
      {
        kind: "an extends target that cannot be resolved",
        files: { "tsconfig.json": { extends: "./missing.json" } },
        named: "tsconfig.json",
      },
    ])("throws naming the file and the cause for $kind", ({ files, named, prepare }) => {
      const dir = createProject(files);
      prepare?.(dir);

      expect(() => {
        assertPluginEntry(join(dir, "tsconfig.json"));
      }).toThrow(
        expect.objectContaining({
          message: expect.stringContaining(join(dir, named)),
          cause: expect.any(Error),
        }),
      );
    });
  });

  describe("when the extends chain cycles", () => {
    it.each([
      {
        kind: "a config extending itself",
        files: { "tsconfig.json": { extends: "./tsconfig.json" } },
        cycle: ["tsconfig.json"],
      },
      {
        kind: "two configs extending each other",
        files: {
          "tsconfig.json": { extends: "./base.json" },
          "base.json": { extends: "./tsconfig.json" },
        },
        cycle: ["tsconfig.json", "base.json"],
      },
      {
        kind: "a cycle further down the chain",
        files: {
          "tsconfig.json": { extends: "./a.json" },
          "a.json": { extends: ["./other.json", "./b.json"] },
          "other.json": withPlugins(OTHER_ENTRY),
          "b.json": { extends: "./a.json" },
        },
        cycle: ["a.json", "b.json"],
      },
    ])("throws naming a file in the cycle for $kind", ({ files, cycle }) => {
      const dir = createProject(files);

      const error = thrownBy(() => {
        assertPluginEntry(join(dir, "tsconfig.json"));
      });

      expect(error.message).toMatch(/\bcyclic\b/);
      expect(error.message).toMatch(anyOf(cycle.map((file) => join(dir, file))));
    });
  });

  describe("when a tsconfig in the chain is malformed", () => {
    it.each([
      {
        kind: "an extends that is a number",
        files: { "tsconfig.json": { extends: 42 } },
        named: "tsconfig.json",
        reason: MENTIONS_EXTENDS,
      },
      {
        kind: "an extends that is an object",
        files: { "tsconfig.json": { extends: { path: "./base.json" } }, "base.json": {} },
        named: "tsconfig.json",
        reason: MENTIONS_EXTENDS,
      },
      {
        kind: "an extends array holding a non-string",
        files: { "tsconfig.json": { extends: ["./base.json", 7] }, "base.json": {} },
        named: "tsconfig.json",
        reason: MENTIONS_EXTENDS,
      },
      {
        kind: "an extended config whose extends is a boolean",
        files: { "tsconfig.json": { extends: "./base.json" }, "base.json": { extends: true } },
        named: "base.json",
        reason: MENTIONS_EXTENDS,
      },
      {
        kind: "a root value that is an array",
        files: { "tsconfig.json": [] },
        named: "tsconfig.json",
        reason: MENTIONS_OBJECT,
      },
      {
        kind: "a root value that is null",
        files: { "tsconfig.json": "null" },
        named: "tsconfig.json",
        reason: MENTIONS_OBJECT,
      },
      {
        kind: "an extended config whose root value is a string",
        files: { "tsconfig.json": { extends: "./base.json" }, "base.json": '"banana"' },
        named: "base.json",
        reason: MENTIONS_OBJECT,
      },
    ])("throws naming the file and the cause for $kind", ({ files, named, reason }) => {
      const dir = createProject(files);

      const error = thrownBy(() => {
        assertPluginEntry(join(dir, "tsconfig.json"));
      });

      expect(error.message).toContain(join(dir, named));
      expect(error.message).toMatch(reason);
    });
  });
});
