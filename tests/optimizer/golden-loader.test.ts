import { join } from "node:path";

import { afterEach, assert, describe, expect, it } from "vitest";

import { createProject, REPO_ROOT, removeTempDirs } from "../unit/plugin/tsconfig-fixtures.js";
import { GOLDEN_FILE } from "./fixture-corpus.js";
import { goldenLoader } from "./golden-loader.js";

afterEach(removeTempDirs);

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
      { source: "ecstatic", expected: join(REPO_ROOT, "src", "ecstatic", "index.ts") },
      { source: "ecstatic/internal", expected: join(REPO_ROOT, "src", "ecstatic", "internal.ts") },
    ])("resolves $source to its source file", ({ source, expected }) => {
      const importer = join(createProject({}), GOLDEN_FILE);

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
      const importer = join(createProject({}), GOLDEN_FILE);

      const resolved = resolveWithContext(context, "../../schema.js", importer);

      expect(resolved).toBe("resolved");
      expect(calls).toStrictEqual([
        ["../../schema.js", importer.slice(0, -".golden".length), { skipSelf: true }],
      ]);
    });
  });

  describe("when a golden fails to transpile", () => {
    it("rejects naming the golden's path and the transpiler's reason", async () => {
      const golden = join(
        createProject({
          [`broken/${GOLDEN_FILE}`]: "export function scenario(): unknown {\n  return {;\n}\n",
        }),
        "broken",
        GOLDEN_FILE,
      );

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
