import { type ChildProcessByStdio, spawn } from "node:child_process";
import { cpSync } from "node:fs";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { createProject, REPO_ROOT, removeTempDirs } from "../unit/plugin/tsconfig-fixtures.js";

const VITE_PLUGIN = pathToFileURL(join(REPO_ROOT, "src", "plugin", "vite.ts")).href;

/** How long one build may take, the compiler process's start included, on a slow CI runner. */
const BUILD_TIMEOUT_MS = 60_000;

/** The reason an async `each()` callback stays a runtime call. */
const ASYNC_REASON = "the callback is async";

/**
 * Runs `vite.build()` in a child process, so whatever channel the plugin warns through (Vite's
 * logger or a direct stderr write) lands in the captured stderr.
 */
const BUILD_SCRIPT = `
const { build } = await import("vite");
const { default: ecstatic } = await import(process.env.SMOKE_VITE_PLUGIN);
const root = process.env.SMOKE_PROJECT_DIR;
const options = JSON.parse(process.env.SMOKE_PLUGIN_OPTIONS);
await build({
  configFile: false,
  root,
  logLevel: "warn",
  plugins: [ecstatic({ project: root + "/tsconfig.json", ...options })],
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

/** A module whose `run()` calls `each()` over one mover with an async callback. */
const ASYNC_CALLBACK_SOURCE = moverSource(`async (e) => {
    e.Position.x += 1;
    await Promise.resolve();
  }`);

/** Starts the build of a copied plugin, so it loads the optimizer beside the copy's `node_modules`. */
const BUILD_START_SCRIPT = `
const { default: ecstatic } = await import(process.env.SMOKE_VITE_PLUGIN);
await ecstatic().buildStart.call({ warn() {} });
`;

/** The tsx loader, by absolute URL, so a child process outside the repository can load TypeScript. */
const TSX_LOADER = import.meta.resolve("tsx");

/** A `typescript` package from before 7.1, whose exports offer none of the optimizer's subpaths. */
const OLD_TYPESCRIPT = {
  "node_modules/typescript/package.json": {
    name: "typescript",
    version: "7.0.0",
    type: "module",
    exports: { ".": "./index.js", "./package.json": "./package.json" },
  },
  "node_modules/typescript/index.js": "export {};\n",
};

interface BuildResult {
  readonly status: number | null;
  readonly stderr: string;
}

afterEach(() => {
  removeTempDirs();
});

/** Writes a project holding {@link ASYNC_CALLBACK_SOURCE} as `main.ts`, whose `ecstatic` resolves to the sources. */
function writeProject(): string {
  return createProject({
    "tsconfig.json": {
      compilerOptions: {
        target: "ES2024",
        module: "preserve",
        moduleResolution: "bundler",
        lib: ["ES2024"],
        types: [],
        strict: true,
        skipLibCheck: true,
        paths: {
          ecstatic: [join(REPO_ROOT, "src", "ecstatic", "index.ts")],
          "ecstatic/internal": [join(REPO_ROOT, "src", "ecstatic", "internal.ts")],
        },
      },
      include: ["."],
    },
    "main.ts": ASYNC_CALLBACK_SOURCE,
  });
}

/** Builds `projectDir` with the ecstatic Vite plugin created from `options`, and reports the exit status and stderr. */
async function viteBuild(
  projectDir: string,
  options: Readonly<Record<string, unknown>> = {},
): Promise<BuildResult> {
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "--eval", BUILD_SCRIPT],
    {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        SMOKE_VITE_PLUGIN: VITE_PLUGIN,
        SMOKE_PROJECT_DIR: projectDir,
        SMOKE_PLUGIN_OPTIONS: JSON.stringify(options),
      },
      stdio: ["ignore", "ignore", "pipe"],
    },
  );
  return await finished(child);
}

/** Collects the stderr of `child` until it exits, and its exit status. */
async function finished(child: ChildProcessByStdio<null, null, Readable>): Promise<BuildResult> {
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

/**
 * Copies the plugin's sources into a new directory holding `files`, then starts its build in a child
 * process run from there, so the optimizer resolves `typescript` only from that directory.
 */
async function startCopiedPlugin(files: Readonly<Record<string, unknown>>): Promise<BuildResult> {
  const dir = createProject({ "package.json": { type: "module" }, ...files });
  cpSync(join(REPO_ROOT, "src", "plugin"), join(dir, "plugin"), { recursive: true });
  const child = spawn(
    process.execPath,
    ["--import", TSX_LOADER, "--input-type=module", "--eval", BUILD_START_SCRIPT],
    {
      cwd: dir,
      env: {
        ...process.env,
        SMOKE_VITE_PLUGIN: pathToFileURL(join(dir, "plugin", "vite.ts")).href,
      },
      stdio: ["ignore", "ignore", "pipe"],
    },
  );
  return await finished(child);
}

describe("ecstatic() Vite plugin", () => {
  describe("when the installed typescript cannot serve the optimizer", () => {
    it.each([
      { name: "is missing", files: {}, cause: /`typescript` package.*not installed/u },
      {
        name: "is older than 7.1",
        files: OLD_TYPESCRIPT,
        cause: /no `typescript\/async` export.*7\.1 or later/u,
      },
    ])(
      "fails the build start naming the cause when typescript $name",
      async ({ files, cause }) => {
        const result = await startCopiedPlugin(files);

        expect(result.stderr).toMatch(cause);
        expect(result.status).not.toBe(0);
      },
      BUILD_TIMEOUT_MS,
    );
  });

  describe("when an each() callback is async", () => {
    it(
      "warns that it stays a runtime call, without failing the build",
      async () => {
        const project = writeProject();

        const result = await viteBuild(project);

        expect(result.stderr).toContain(
          `The each() call cannot be optimized (${ASYNC_REASON}). It compiles to the runtime call`,
        );
        expect(result.status).toBe(0);
      },
      BUILD_TIMEOUT_MS,
    );

    it(
      "fails the build naming the reason when strict",
      async () => {
        const project = writeProject();

        const result = await viteBuild(project, { strict: true });

        expect(result.stderr).toContain(
          `(${ASYNC_REASON}). It compiles to the runtime call (strict mode).`,
        );
        expect(result.status).not.toBe(0);
      },
      BUILD_TIMEOUT_MS,
    );
  });
});
