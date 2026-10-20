import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import { pathToFileURL } from "node:url";

import { afterAll, assert, beforeAll, describe, expect, it } from "vitest";

import { packageBin } from "../../package-bin.js";
import { createTempDir, REPO_ROOT, removeTempDirs } from "./tsconfig-fixtures.js";

const BUILD_TIMEOUT_MS = 120_000;
const TSC = packageBin("typescript", "tsc");
const BUILD_PROJECTS = ["tsconfig.build.json", "tsconfig.build-plugin.json"];
const PACKED_SOURCES = ["package.json", ".gitignore", "src", "optimizer"];
/** Go module files outside optimizer/, planted in the packed tree to prove `files` leaves them out. */
const DECOY_GO_FILES = ["transform/go.mod", "transform/main.go"];

/** Whether a path is a Go source, go.mod, or go.sum file. */
function isGoModuleFile(path: string): boolean {
  return path.endsWith(".go") || path.endsWith("/go.mod") || path.endsWith("/go.sum");
}

/** Narrows a parsed JSON value to a plain object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** This repository's parsed package.json. */
function readManifest(): Record<string, unknown> {
  const manifest: unknown = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8"));
  assert(isRecord(manifest));
  return manifest;
}

/** The entry `name` of the manifest's object field `field`. */
function manifestEntry(field: string, name: string): unknown {
  const entries = readManifest()[field];
  assert(isRecord(entries));
  return entries[name];
}

/** Whether a path under optimizer/ is go.mod or a non-test `.go` file outside tools/. */
function isPackedGoFile(relative: string): boolean {
  return (
    relative === "go.mod" ||
    (relative.endsWith(".go") && !relative.endsWith("_test.go") && !relative.startsWith("tools/"))
  );
}

/** The Go files a consumer's ttsc build needs: optimizer/go.mod and every non-test `.go` file outside optimizer/tools/. */
function expectedGoFiles(): string[] {
  const optimizerDir = join(REPO_ROOT, "optimizer");
  return readdirSync(optimizerDir, { recursive: true, encoding: "utf8" })
    .map((relative) => relative.split(sep).join("/"))
    .filter(isPackedGoFile)
    .map((relative) => `optimizer/${relative}`)
    .toSorted();
}

/** Narrows a parsed `npm pack --json` result to its first tarball's file paths. */
function packedPaths(output: string): string[] {
  const parsed: unknown = JSON.parse(output);
  assert(Array.isArray(parsed));
  const [tarball]: unknown[] = parsed;
  assert(isRecord(tarball));
  const files = tarball["files"];
  assert(Array.isArray(files));
  return files.map((file: unknown) => {
    assert(isRecord(file));
    const path = file["path"];
    assert(typeof path === "string");
    return path;
  });
}

describe("package manifest", () => {
  it.each(["ttsc", "@ttsc/unplugin"])(
    "declares %s as an optional ~0.32.1 peer pinned to 0.32.1 for development",
    (name) => {
      const declared = {
        peer: manifestEntry("peerDependencies", name),
        peerMeta: manifestEntry("peerDependenciesMeta", name),
        dev: manifestEntry("devDependencies", name),
      };

      expect(declared).toStrictEqual({
        peer: "~0.32.1",
        peerMeta: { optional: true },
        dev: "0.32.1",
      });
    },
  );

  it("exports exactly the root, internal, optimizer, and vite subpaths", () => {
    const exportsField = readManifest()["exports"];
    assert(isRecord(exportsField));

    expect(Object.keys(exportsField)).toStrictEqual([".", "./internal", "./optimizer", "./vite"]);
  });

  it("packs only dist, src, and the optimizer's Go module without its tests and tools", () => {
    const files = readManifest()["files"];

    expect(files).toStrictEqual([
      "dist",
      "src",
      "optimizer/go.mod",
      "optimizer/**/*.go",
      "!optimizer/**/*_test.go",
      "!optimizer/tools/**",
    ]);
  });

  it("runs the Go tests from optimizer/ and gates their coverage", () => {
    const script = manifestEntry("scripts", "test:go");

    expect(script).toMatch(/ -C optimizer test .*-coverprofile=\.\.\/coverage\/go\.out/);
    expect(script).toContain("scripts/check-go-coverage.ts coverage/go.out");
  });
});

describe("built package", () => {
  let outDir = "";
  let packed: string[] = [];

  beforeAll(() => {
    const projectDir = createTempDir();
    outDir = join(projectDir, "dist");
    for (const project of BUILD_PROJECTS) {
      execFileSync(process.execPath, [TSC, "-p", project, "--outDir", outDir], {
        cwd: REPO_ROOT,
        stdio: "pipe",
      });
    }
    for (const source of PACKED_SOURCES) {
      cpSync(join(REPO_ROOT, source), join(projectDir, source), { recursive: true });
    }
    for (const decoy of DECOY_GO_FILES) {
      mkdirSync(dirname(join(projectDir, decoy)), { recursive: true });
      writeFileSync(join(projectDir, decoy), "package banana\n");
    }
    const output = execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
      cwd: projectDir,
      encoding: "utf8",
      shell: process.platform === "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    packed = packedPaths(output);
  }, BUILD_TIMEOUT_MS);

  afterAll(removeTempDirs);

  it.each([
    { subpath: ".", built: "index" },
    { subpath: "./internal", built: "internal" },
    { subpath: "./optimizer", built: "plugin/optimizer" },
    { subpath: "./vite", built: "plugin/vite" },
  ])("exports $subpath from built dist/$built files", ({ subpath, built }) => {
    const entry = manifestEntry("exports", subpath);

    expect(entry).toStrictEqual({ types: `./dist/${built}.d.ts`, default: `./dist/${built}.js` });
    expect(existsSync(join(outDir, `${built}.d.ts`))).toBe(true);
    expect(existsSync(join(outDir, `${built}.js`))).toBe(true);
  });

  it("exposes a working assertShape from the built internal entry", async () => {
    const runtime: unknown = await import(pathToFileURL(join(outDir, "index.js")).href);
    const internal: unknown = await import(pathToFileURL(join(outDir, "internal.js")).href);
    assert(isRecord(runtime) && isRecord(internal));
    const { archetype, component, createWorld, register } = runtime;
    const { assertShape } = internal;
    assert(typeof archetype === "function" && typeof component === "function");
    assert(typeof createWorld === "function" && typeof register === "function");
    assert(typeof assertShape === "function");
    const storage: unknown = register(createWorld(), archetype([component("Packaged", { n: 0 })]));

    expect(() => assertShape(storage, "c8:Packaged{1:n=n}|")).not.toThrow();
    expect(() => assertShape(storage, "c8:Packaged{}|")).toThrow(
      "ecstatic: shape guard expected c8:Packaged{}|, got c8:Packaged{1:n=n}|",
    );
  });

  it("declares the optimizer descriptor without importing ttsc", () => {
    const declaration = readFileSync(join(outDir, "plugin", "optimizer.d.ts"), "utf8");

    expect(declaration).not.toMatch(/["']ttsc(?:\/[^"']*)?["']/);
  });

  it("packs no Go files but go.mod and the non-test Go sources under optimizer/", () => {
    const packedGo = packed.filter(isGoModuleFile).toSorted();

    expect(packedGo).toStrictEqual(expectedGoFiles());
  });

  it.each(["dist/index.js", "dist/plugin/optimizer.js", "src/index.ts", "src/plugin/optimizer.ts"])(
    "packs %s",
    (file) => {
      expect(packed).toContain(file);
    },
  );
});
