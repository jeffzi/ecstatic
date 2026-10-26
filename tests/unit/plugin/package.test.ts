import { execFileSync } from "node:child_process";
import { cpSync, existsSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, relative, sep } from "node:path";
import { pathToFileURL } from "node:url";

import { normalizePath } from "vite";
import { afterAll, assert, beforeAll, describe, expect, it, onTestFinished } from "vitest";

import type createPlugin from "../../../src/plugin/vite.js";
import { buildProjects } from "../../build-projects.js";
import { packageBin } from "../../package-bin.js";
import { SPAWN_TIMEOUT_MS } from "../optimizer/project.js";
import { createProject, REPO_ROOT, removeTempDirs, writeFixture } from "./tsconfig-fixtures.js";
import { startPlugin } from "./vite-host.js";

const BUILD_TIMEOUT_MS = 120_000;
const TSC = packageBin("typescript", "tsc");
/** What the build and `npm pack` read beside the build's projects, copied so neither touches the repository's own tree. */
const COPIED_SOURCES = ["package.json", ".gitignore", "tsconfig.json", "src"];
/** A file under a top-level optimizer/ tree, planted in the copied tree to prove `files` leaves it out. */
const DECOY_OPTIMIZER_FILE = "optimizer/banana.ts";
/** The packed tarball declares these as optional peers and does not bundle them, so the consumer project links them from the repository's node_modules. */
const CONSUMER_PEERS = ["typescript", "vite"];
const CONSUMER_FILE = "app/main.ts";
/** A `DEBUG` initializer only the installed package's `src/ecstatic/debug.ts` carries, so a copy taken from any other `debug.ts` shows. */
const INSTALLED_DEBUG_INITIALIZER = 'typeof NDEBUG === "undefined" || NDEBUG !== true';
/** An eligible `each` call over the installed package. */
const CONSUMER_SOURCE = `import { archetype, component, each, type Storage } from "ecstatic";

const Spot = component("Spot", { x: 0 });
const Marker = archetype([Spot]);
declare const markers: Storage<typeof Marker>;

each(markers, (e) => {
    e.Spot.x += 1;
});
`;
const CONSUMER_TSCONFIG = {
  compilerOptions: {
    strict: true,
    target: "es2024",
    lib: ["es2024"],
    module: "nodenext",
    noEmit: true,
    skipLibCheck: true,
    types: [],
  },
  include: ["app"],
};

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

/** Every file under `dir`, as a slash-separated path relative to `root`. */
function filesUnder(root: string, dir: string): string[] {
  return readdirSync(join(root, dir), { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(root, join(entry.parentPath, entry.name)).split(sep).join("/"));
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

/** The gate of the first shape guard in `text`, inside its parentheses, or undefined when there is none. */
function guardGate(text: string): string | undefined {
  return /^\s*\((.+)\) && [\w$]+\.assertShape\(/mu.exec(text)?.[1];
}

/** The text of the code a transform returned, or the empty string when it returned none. */
function transformedCode(result: unknown): string {
  return isRecord(result) && typeof result["code"] === "string" ? result["code"] : "";
}

/** Whether a loaded module's default export is the plugin factory the built `ecstatic/vite` entry declares. */
function isPluginFactory(value: unknown): value is typeof createPlugin {
  return typeof value === "function";
}

describe("package manifest", () => {
  it("exports exactly the root, internal, and vite subpaths", () => {
    const exportsField = readManifest()["exports"];
    assert(isRecord(exportsField));

    expect(Object.keys(exportsField)).toStrictEqual([".", "./internal", "./vite"]);
  });

  it.each([
    { name: "typescript", peer: "7.1.0-dev.20261020.3" },
    { name: "vite", peer: "^8.0.0" },
  ])("declares $name as an optional $peer peer", ({ name, peer }) => {
    const declared = {
      peer: manifestEntry("peerDependencies", name),
      peerMeta: manifestEntry("peerDependenciesMeta", name),
    };

    expect(declared).toStrictEqual({ peer, peerMeta: { optional: true } });
  });

  it("develops against vite ^8.3.4", () => {
    const dev = manifestEntry("devDependencies", "vite");

    expect(dev).toBe("^8.3.4");
  });
});

describe("built package", () => {
  let buildDir = "";
  let distDir = "";
  let packed: string[] = [];
  let runtimeSources: string[] = [];
  let consumer = "";

  beforeAll(() => {
    buildDir = createProject({});
    distDir = join(buildDir, "dist");
    const projects = buildProjects();
    for (const source of [...COPIED_SOURCES, ...projects]) {
      cpSync(join(REPO_ROOT, source), join(buildDir, source), { recursive: true });
    }
    symlinkSync(join(REPO_ROOT, "node_modules"), join(buildDir, "node_modules"), "junction");
    runtimeSources = filesUnder(buildDir, join("src", "ecstatic"));
    for (const project of projects) {
      execFileSync(process.execPath, [TSC, "-p", project], { cwd: buildDir, stdio: "pipe" });
    }
    writeFixture(join(buildDir, DECOY_OPTIMIZER_FILE), "export const banana = 1;\n");
    const output = execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
      cwd: buildDir,
      encoding: "utf8",
      shell: process.platform === "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    packed = packedPaths(output);

    consumer = createProject({
      "package.json": { name: "consumer", type: "module", private: true },
      "tsconfig.json": CONSUMER_TSCONFIG,
      [CONSUMER_FILE]: CONSUMER_SOURCE,
    });
    const installed = join(consumer, "node_modules", "ecstatic");
    for (const path of packed) {
      cpSync(join(buildDir, path), join(installed, path));
    }
    const installedDebug = join(installed, "src", "ecstatic", "debug.ts");
    writeFileSync(
      installedDebug,
      readFileSync(installedDebug, "utf8").replace(
        /^export const DEBUG = .+;$/mu,
        `export const DEBUG = ${INSTALLED_DEBUG_INITIALIZER};`,
      ),
    );
    for (const peer of CONSUMER_PEERS) {
      symlinkSync(
        join(REPO_ROOT, "node_modules", peer),
        join(consumer, "node_modules", peer),
        "junction",
      );
    }
  }, BUILD_TIMEOUT_MS);

  afterAll(removeTempDirs);

  it.each([
    { subpath: ".", stem: "index" },
    { subpath: "./internal", stem: "internal" },
    { subpath: "./vite", stem: "plugin/vite" },
  ])("exports $subpath from built dist/$stem files", ({ subpath, stem }) => {
    const entry = manifestEntry("exports", subpath);

    expect(entry).toStrictEqual({ types: `./dist/${stem}.d.ts`, default: `./dist/${stem}.js` });
    expect(existsSync(join(distDir, `${stem}.d.ts`))).toBe(true);
    expect(existsSync(join(distDir, `${stem}.js`))).toBe(true);
  });

  it("declares only the plugin factory and the EcstaticOptions type in the built vite entry", () => {
    const declarations = readFileSync(join(distDir, "plugin", "vite.d.ts"), "utf8");

    const exported = declarations.match(/^export .+$/gmu);

    expect(exported).toStrictEqual([
      'export type { EcstaticOptions } from "./options.js";',
      "export default function ecstatic(options?: EcstaticOptions): Plugin;",
    ]);
  });

  it("exposes a working assertShape from the packed internal entry", async () => {
    const resolve = createRequire(join(consumer, "package.json")).resolve;
    const runtime: unknown = await import(pathToFileURL(resolve("ecstatic")).href);
    const internal: unknown = await import(pathToFileURL(resolve("ecstatic/internal")).href);
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

  it("packs every file the build wrote to dist", () => {
    const built = filesUnder(buildDir, "dist").toSorted();

    const packedDist = packed.filter((path) => path.startsWith("dist/")).toSorted();

    expect(packedDist).toStrictEqual(built);
  });

  it.each(["src/ecstatic/index.ts", "src/ecstatic/debug.ts"])("packs %s", (file) => {
    expect(packed).toContain(file);
  });

  it("packs every runtime source file", () => {
    const packedSources = packed.filter((path) => path.startsWith("src/ecstatic/")).toSorted();

    expect(packedSources).toStrictEqual(runtimeSources.toSorted());
  });

  it.each(["src/plugin/", "optimizer/"])("packs nothing under %s", (prefix) => {
    const under = packed.filter((path) => path.startsWith(prefix));

    expect(under).toStrictEqual([]);
  });

  it(
    "rewrites an inline each through the packed plugin, gating its guard with the packed runtime's DEBUG initializer",
    async () => {
      const entry = createRequire(join(consumer, "package.json")).resolve("ecstatic/vite");
      const module: unknown = await import(pathToFileURL(entry).href);
      assert(isRecord(module) && isPluginFactory(module["default"]));
      const host = await startPlugin(consumer, module["default"]());
      onTestFinished(() => host.close());

      const code = transformedCode(
        await host.transform(CONSUMER_SOURCE, normalizePath(join(consumer, CONSUMER_FILE))),
      );

      expect(guardGate(code)).toBe(INSTALLED_DEBUG_INITIALIZER);
    },
    SPAWN_TIMEOUT_MS,
  );
});

describe("CHANGELOG.md", () => {
  it("records the plugin under Added in the unreleased section", () => {
    const changelog = readFileSync(join(REPO_ROOT, "CHANGELOG.md"), "utf8");
    const unreleased = changelog
      .split(/^## /mu)
      .find((section) => section.startsWith("[Unreleased]"));
    const added = unreleased?.split(/^### /mu).find((section) => section.startsWith("Added"));

    expect(added).toContain("`ecstatic/vite` plugin");
  });
});
