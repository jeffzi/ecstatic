import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, assert, describe, expect, it } from "vitest";

import { goldenLoader } from "./golden-loader.js";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** Creates an empty temp directory the `afterEach` hook deletes and returns its real path. */
function createTempDir(): string {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), "ecstatic-golden-"));
  tempDirs.push(dir);
  return dir;
}

/** Writes `content` to `file`, creating parent directories first. */
function writeFixture(file: string, content: string): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
}

/** Builds the loader plugin and returns its named hook bound to the plugin. */
function hook(name: "resolveId" | "load"): (...args: unknown[]) => unknown {
  const plugin: unknown = goldenLoader();
  assert(typeof plugin === "object" && plugin !== null && name in plugin);
  const fn: unknown = Reflect.get(plugin, name);
  assert(typeof fn === "function");
  return (...args) => fn.call(plugin, ...args);
}

/** Runs the loader's `resolveId` hook for `source` imported from `importer`. */
function resolveFrom(source: string, importer: string): unknown {
  return hook("resolveId")(source, importer, { isEntry: false, attributes: {} });
}

/** Runs the loader's `resolveId` hook with `context` as the plugin context Vite would pass. */
function resolveWithContext(context: object, source: string, importer: string): unknown {
  const plugin: unknown = goldenLoader();
  assert(typeof plugin === "object" && plugin !== null);
  const fn: unknown = Reflect.get(plugin, "resolveId");
  assert(typeof fn === "function");
  return fn.call(context, source, importer, { isEntry: false, attributes: {} });
}

/** Runs the loader's `load` hook for the module `id`. */
async function loadModule(id: string): Promise<unknown> {
  return await hook("load")(id);
}

describe("goldenLoader", () => {
  describe("when a golden imports the runtime", () => {
    it.each([
      { source: "ecstatic", expected: join(REPO_ROOT, "src", "index.ts") },
      { source: "ecstatic/internal", expected: join(REPO_ROOT, "src", "internal.ts") },
    ])("resolves $source to its source file", ({ source, expected }) => {
      const importer = join(createTempDir(), "expected.ts.golden");

      const resolved = resolveFrom(source, importer);

      expect(resolved).toBe(expected);
    });
  });

  describe("when a golden imports any other module", () => {
    it("resolves it as Vite would from the golden's namesake .ts", () => {
      const calls: unknown[][] = [];
      const context = {
        resolve: (...args: unknown[]) => {
          calls.push(args);
          return "resolved";
        },
      };
      const importer = join(createTempDir(), "expected.ts.golden");

      const resolved = resolveWithContext(context, "../../schema.js", importer);

      expect(resolved).toBe("resolved");
      expect(calls).toStrictEqual([
        ["../../schema.js", importer.slice(0, -".golden".length), { skipSelf: true }],
      ]);
    });
  });

  describe("when a golden fails to transpile", () => {
    it("rejects naming the golden's path and the transpiler's reason", async () => {
      const golden = join(createTempDir(), "broken", "expected.ts.golden");
      writeFixture(golden, "export function scenario(): unknown {\n  return {;\n}\n");

      const loading = loadModule(golden);

      await expect(loading).rejects.toThrow(`cannot transpile golden ${golden}: `);
      await expect(loading).rejects.toSatisfy(
        (error) =>
          error instanceof Error &&
          error.cause instanceof Error &&
          error.message.endsWith(error.cause.message),
      );
    });
  });
});
