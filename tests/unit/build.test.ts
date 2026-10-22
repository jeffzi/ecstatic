import { execFile } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { promisify } from "node:util";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { buildProjects, projectsOf } from "../build-projects.js";
import { packageBin } from "../package-bin.js";

const execFileAsync = promisify(execFile);

const ROOT = resolve(import.meta.dirname, "../..");

const SRC_DIR = join(ROOT, "src");

const RUNTIME_DIR = join(SRC_DIR, "ecstatic");

const PLUGIN_DIR = join(SRC_DIR, "plugin");

const NODE_TYPES_DIR = join("node_modules", "@types", "node");

/** The files a build reads beside its projects, relative to the repository root; `node_modules` is linked, not copied. */
const BUILD_INPUTS = ["package.json", "tsconfig.json", "src"];

/** How long building a copy of the package may take on a slow CI runner. */
const BUILD_TIMEOUT_MS = 60_000;

/** Runs `tsc` with `args` from `cwd` and returns its standard output. */
async function tsc(args: readonly string[], cwd = ROOT): Promise<string> {
  const { stdout } = await execFileAsync(
    process.execPath,
    [packageBin("typescript", "tsc"), ...args],
    { cwd },
  );
  return stdout;
}

/** The absolute paths of every file `tsc` compiles for the project at `tsconfig` under `cwd`. */
async function compiledFiles(tsconfig: string, cwd = ROOT): Promise<string[]> {
  const stdout = await tsc(["--listFilesOnly", "-p", tsconfig], cwd);
  return stdout
    .split(/\r?\n/)
    .filter((line) => line !== "")
    .map((file) => resolve(file));
}

/** The paths, relative to `dir`, of every TypeScript module under `dir`. */
function modulesUnder(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: "utf8" }).filter((file) =>
    file.endsWith(".ts"),
  );
}

/**
 * The files among `files` that are neither under the tree `dir` nor installed dependencies: a
 * sibling tree, or the package's own `dist/` that a self-import by package name resolves to.
 */
function outsideTree(files: readonly string[], dir: string): string[] {
  const dependencies = `${sep}node_modules${sep}`;
  return files.filter((file) => !file.startsWith(dir + sep) && !file.includes(dependencies));
}

/** The JavaScript and declaration files missing under `outDir` for the modules under `srcDir`. */
function missingEmitted(srcDir: string, outDir: string): string[] {
  return modulesUnder(srcDir)
    .flatMap((rel) => {
      const stem = join(outDir, rel.slice(0, -".ts".length));
      return [`${stem}.js`, `${stem}.d.ts`];
    })
    .filter((file) => !existsSync(file));
}

interface PackageManifest {
  devDependencies: Record<string, string>;
  scripts: Record<string, string>;
  exports: Record<string, Record<string, string>>;
}

/** The fields of the repository's package.json the build tests read. */
function readManifest(): PackageManifest {
  return JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
}

/** The `&&`-separated commands of the package script `name`. */
function packageScript(name: string): string[] {
  return (readManifest().scripts[name] ?? "").split("&&").map((command) => command.trim());
}

/** Every file path the package's `exports` map names, relative to the package root. */
function exportTargets(): string[] {
  return Object.values(readManifest().exports).flatMap((conditions) => Object.values(conditions));
}

/** The TypeScript nightly whose compiler API the optimizer is written against. */
const PINNED_TYPESCRIPT = "7.1.0-dev.20261020.3";

describe("build", () => {
  describe("typescript dev dependency", () => {
    it("is pinned to exactly the optimizer's nightly, and installed at it", () => {
      const { devDependencies } = readManifest();
      const { version }: { version: string } = JSON.parse(
        readFileSync(join(ROOT, "node_modules", "typescript", "package.json"), "utf8"),
      );

      expect(devDependencies["typescript"]).toBe(PINNED_TYPESCRIPT);
      expect(version).toBe(PINNED_TYPESCRIPT);
    });

    it("is exempt, with its compiler binaries, from the release-age cooldown", () => {
      const npmrc = readFileSync(join(ROOT, ".npmrc"), "utf8").split(/\r?\n/);

      const exempt = npmrc.filter((line) => line.startsWith("min-release-age-exclude[]="));

      expect(exempt).toStrictEqual([
        "min-release-age-exclude[]=typescript",
        "min-release-age-exclude[]=@typescript/typescript-*",
      ]);
    });
  });

  describe("source layout", () => {
    it("holds exactly the runtime tree and the plugin tree under src/", () => {
      const entries = readdirSync(SRC_DIR).filter((entry) => !entry.startsWith("."));

      expect(entries.toSorted()).toStrictEqual(["ecstatic", "plugin"]);
    });
  });

  describe("ecstatic path mappings", () => {
    it.each([
      { tsconfig: "tests/tsconfig.json", specifier: "ecstatic", module: "index.ts" },
      { tsconfig: "tests/tsconfig.json", specifier: "ecstatic/internal", module: "internal.ts" },
      {
        tsconfig: "tests/integration/fixtures/tsconfig.json",
        specifier: "ecstatic",
        module: "index.ts",
      },
      {
        tsconfig: "tests/integration/fixtures/tsconfig.json",
        specifier: "ecstatic/internal",
        module: "internal.ts",
      },
      { tsconfig: "examples/tsconfig.json", specifier: "ecstatic", module: "index.ts" },
      { tsconfig: "benchmarks/tsconfig.json", specifier: "ecstatic", module: "index.ts" },
    ])("$tsconfig maps $specifier into the runtime tree", ({ tsconfig, specifier, module }) => {
      const config = join(ROOT, tsconfig);
      const {
        compilerOptions: { paths },
      }: { compilerOptions: { paths: Record<string, string[]> } } = JSON.parse(
        readFileSync(config, "utf8"),
      );

      const targets = (paths[specifier] ?? []).map((target) => join(dirname(config), target));

      expect(targets).toStrictEqual([join(RUNTIME_DIR, module)]);
    });
  });

  describe("runtime project", () => {
    it("excludes no path, only test files", () => {
      const { exclude }: { exclude: string[] } = JSON.parse(
        readFileSync(join(ROOT, "tsconfig.build.json"), "utf8"),
      );

      expect(exclude).toStrictEqual(["**/*.test.ts"]);
    });
  });

  describe("a built copy of the package", () => {
    let copy = "";

    beforeAll(async () => {
      copy = mkdtempSync(join(realpathSync.native(tmpdir()), "ecstatic-build-"));
      const projects = buildProjects();
      for (const input of [...BUILD_INPUTS, ...projects]) {
        cpSync(join(ROOT, input), join(copy, input), { recursive: true });
      }
      symlinkSync(join(ROOT, "node_modules"), join(copy, "node_modules"), "dir");
      for (const project of projects) {
        await tsc(["-p", project], copy);
      }
    }, BUILD_TIMEOUT_MS);

    afterAll(() => {
      rmSync(copy, { recursive: true, force: true });
    });

    it("compiles only the runtime tree for the runtime project, without the Node types", async () => {
      const runtime = join(copy, "src", "ecstatic");

      const files = await compiledFiles("tsconfig.build.json", copy);

      expect(files).toContain(join(runtime, "index.ts"));
      expect(outsideTree(files, runtime)).toStrictEqual([]);
      expect(files.filter((file) => file.includes(NODE_TYPES_DIR))).toStrictEqual([]);
    });

    it("compiles every plugin module and nothing else of the package for the plugin project, with the Node types", async () => {
      const plugin = join(copy, "src", "plugin");

      const files = await compiledFiles("tsconfig.build-plugin.json", copy);

      const compiled = new Set(files);
      const missing = modulesUnder(PLUGIN_DIR).filter((rel) => !compiled.has(join(plugin, rel)));
      expect(missing).toStrictEqual([]);
      expect(outsideTree(files, plugin)).toStrictEqual([]);
      expect(files.some((file) => file.includes(NODE_TYPES_DIR))).toBe(true);
    });

    it("emits each runtime module to dist/ at the path it has under src/ecstatic/", () => {
      const missing = missingEmitted(RUNTIME_DIR, join(copy, "dist"));

      expect(missing).toStrictEqual([]);
    });

    it("emits each plugin module to dist/plugin/ at the path it has under src/plugin/", () => {
      const missing = missingEmitted(PLUGIN_DIR, join(copy, "dist", "plugin"));

      expect(missing).toStrictEqual([]);
    });

    it("holds every file the package exports", () => {
      const missing = exportTargets().filter((target) => !existsSync(join(copy, target)));

      expect(missing).toStrictEqual([]);
    });
  });

  describe("build projects", () => {
    it("are the tsconfig each command of the build script compiles, in script order", () => {
      const projects = projectsOf("tsc -p tsconfig.build.json && tsc -p sub/tsconfig.json ");

      expect(projects).toStrictEqual(["tsconfig.build.json", "sub/tsconfig.json"]);
    });

    it.each(["tsc -p tsconfig.build.json --noEmit", "node build.js", "tsc --build"])(
      "reject a build script that runs %s, naming the command",
      (command) => {
        expect(() => projectsOf(`tsc -p tsconfig.build.json && ${command}`)).toThrow(
          `the build script runs ${command}, not a tsc project`,
        );
      },
    );

    describe("of a package", () => {
      let dir = "";

      afterEach(() => {
        rmSync(dir, { recursive: true, force: true });
      });

      it("are read from its build script", () => {
        dir = mkdtempSync(join(realpathSync.native(tmpdir()), "ecstatic-projects-"));
        const manifest = { scripts: { build: "tsc -p a.json && tsc -p b.json" } };
        writeFileSync(join(dir, "package.json"), JSON.stringify(manifest));

        const projects = buildProjects(dir);

        expect(projects).toStrictEqual(["a.json", "b.json"]);
      });

      it.each([
        { manifest: { scripts: { test: "vitest" } }, error: "package.json has no build script" },
        { manifest: null, error: "package.json has no build script" },
        {
          manifest: { scripts: { build: "tsc -p a.json && node build.js" } },
          error: "the build script runs node build.js, not a tsc project",
        },
      ])("reject the manifest $manifest", ({ manifest, error }) => {
        dir = mkdtempSync(join(realpathSync.native(tmpdir()), "ecstatic-projects-"));
        writeFileSync(join(dir, "package.json"), JSON.stringify(manifest));

        expect(() => buildProjects(dir)).toThrow(error);
      });
    });
  });

  describe("package scripts", () => {
    it.each([
      {
        script: "build",
        commands: ["tsc -p tsconfig.build.json", "tsc -p tsconfig.build-plugin.json"],
      },
      {
        script: "check:type",
        commands: [
          "tsc -p tsconfig.build.json --noEmit",
          "tsc -p tsconfig.build-plugin.json --noEmit",
          "tsc -p examples/tsconfig.json --noEmit",
          "tsc -p benchmarks/tsconfig.json --noEmit",
        ],
      },
    ])("$script runs exactly its commands, the runtime project first", ({ script, commands }) => {
      const actual = packageScript(script);

      expect(actual).toStrictEqual(commands);
    });
  });
});
