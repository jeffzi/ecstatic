import { spawn } from "node:child_process";
import { symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
  createTempDir,
  DESCRIPTOR_SOURCE,
  REPO_ROOT,
  removeTempDirs,
} from "../unit/plugin/tsconfig-fixtures.js";

const VITE_PLUGIN = pathToFileURL(join(REPO_ROOT, "src", "plugin", "vite.ts")).href;

/** The first build compiles the Go optimizer through ttsc, about a minute on a cold cache. */
const BUILD_TIMEOUT_MS = 240_000;

/**
 * Runs `vite.build()` in a child process, so whatever channel the plugin warns through (Vite's
 * logger or a direct stderr write) lands in the captured stderr.
 */
const BUILD_SCRIPT = `
const { build } = await import("vite");
const { default: ecstatic } = await import(process.env.SMOKE_VITE_PLUGIN);
const root = process.env.SMOKE_PROJECT_DIR;
await build({
  configFile: false,
  root,
  logLevel: "warn",
  plugins: [ecstatic({ project: root + "/tsconfig.json" })],
  build: {
    write: false,
    minify: false,
    lib: { entry: root + "/main.ts", formats: ["es"] },
    rolldownOptions: { external: [/^ecstatic/] },
  },
});
`;

/** A module whose `run()` calls `each()` over one mover with the `callback` expression. */
function moverSource(callback: string): string {
  return `
import { archetype, component, createWorld, each, register, spawn } from "ecstatic";

const Position = component("Position", { x: 0, y: 0 });
const Mover = archetype([Position]);

export function run(): void {
  const movers = register(createWorld(), Mover);
  spawn(movers, { Position: { x: 1, y: 0 } });

  each(movers, ${callback});
}
`;
}

const ASYNC_CALLBACK_SOURCE = moverSource(`async (e) => {
    e.Position.x += 1;
    await Promise.resolve();
  }`);

const SYNC_CALLBACK_SOURCE = moverSource(`(e) => {
    e.Position.x += 1;
  }`);

interface BuildResult {
  readonly status: number | null;
  readonly stderr: string;
}

afterEach(() => {
  removeTempDirs();
});

/** Writes a project whose tsconfig enables the optimizer with `pluginOptions` and holds `source`. */
function writeProject(source: string, pluginOptions: Record<string, unknown> = {}): string {
  const dir = createTempDir();
  // ttsc resolves typescript from the project and keeps its built-plugin cache in the
  // project's node_modules/.cache/ttsc; linking the repository's shares both.
  symlinkSync(join(REPO_ROOT, "node_modules"), join(dir, "node_modules"));
  const tsconfig = {
    compilerOptions: {
      target: "ES2024",
      module: "preserve",
      moduleResolution: "bundler",
      lib: ["ES2024"],
      types: [],
      strict: true,
      skipLibCheck: true,
      paths: {
        ecstatic: [join(REPO_ROOT, "src", "index.ts")],
        "ecstatic/internal": [join(REPO_ROOT, "src", "internal.ts")],
      },
      plugins: [{ transform: DESCRIPTOR_SOURCE, ...pluginOptions }],
    },
    include: ["."],
  };
  writeFileSync(join(dir, "tsconfig.json"), JSON.stringify(tsconfig, undefined, 2));
  writeFileSync(join(dir, "main.ts"), source);
  return dir;
}

/** Builds `projectDir` with the ecstatic Vite plugin and reports the exit status and stderr. */
async function viteBuild(projectDir: string): Promise<BuildResult> {
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "--eval", BUILD_SCRIPT],
    {
      cwd: REPO_ROOT,
      env: { ...process.env, SMOKE_VITE_PLUGIN: VITE_PLUGIN, SMOKE_PROJECT_DIR: projectDir },
      stdio: ["ignore", "ignore", "pipe"],
    },
  );
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  const status = await new Promise<number | null>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", resolve);
  });
  return { status, stderr };
}

describe("ecstatic() Vite plugin", () => {
  describe("when an each() callback is async", () => {
    it(
      "warns that it stays a runtime call, without failing the build",
      async () => {
        const project = writeProject(ASYNC_CALLBACK_SOURCE);

        const result = await viteBuild(project);

        expect(result.stderr).toContain(
          "The each() call cannot be optimized (the callback is async). It compiles to the runtime call",
        );
        expect(result.status).toBe(0);
      },
      BUILD_TIMEOUT_MS,
    );
  });

  describe("when the tsconfig entry has an unknown option", () => {
    it(
      "fails the build naming the option",
      async () => {
        const project = writeProject(SYNC_CALLBACK_SOURCE, { banana: true });

        const result = await viteBuild(project);

        expect(result.stderr).toContain('unknown ecstatic/optimizer option "banana"');
        expect(result.status).not.toBe(0);
      },
      BUILD_TIMEOUT_MS,
    );
  });
});
