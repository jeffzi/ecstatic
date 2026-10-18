import { join } from "node:path";

import { afterEach, assert, describe, expect, it, vi } from "vitest";

import ecstatic from "../../../src/plugin/vite.js";
import {
  createProject,
  ECSTATIC_ENTRY,
  OTHER_ENTRY,
  removeTempDirs,
  withPlugins,
  writeFixture,
} from "./tsconfig-fixtures.js";

vi.mock("@ttsc/unplugin/vite", () => ({
  default: (options: unknown) => ({ name: "ttsc-vite", options }),
}));

afterEach(() => {
  vi.restoreAllMocks();
  removeTempDirs();
});

/** The entry-check plugin `ecstatic()` puts first when no project is given. */
function createEntryCheck(): unknown {
  const plugins = ecstatic();
  assert(Array.isArray(plugins));
  return plugins[0];
}

/** Runs a plugin's `transform` hook on an empty module with the given id. */
function transformModule(plugin: unknown, id: string): unknown {
  assert(typeof plugin === "object" && plugin !== null && "transform" in plugin);
  const { transform } = plugin;
  assert(typeof transform === "function");
  return transform.call(plugin, "", id);
}

describe("ecstatic() for Vite", () => {
  describe("when a project is given", () => {
    it.each([
      {
        kind: "all three options",
        options: (project: string, dir: string) => ({
          project,
          projectRoot: dir,
          precompile: [join(dir, "src", "main.ts")],
        }),
        expected: (project: string, dir: string) => ({
          project,
          projectRoot: dir,
          precompile: [join(dir, "src", "main.ts")],
        }),
      },
      {
        kind: "an unknown option, stripped",
        options: (project: string) => ({
          project,
          plugins: [{ transform: "banana/transform" }],
        }),
        expected: (project: string) => ({ project }),
      },
    ])("forwards only project, projectRoot, and precompile ($kind)", ({ options, expected }) => {
      const dir = createProject({ "tsconfig.json": withPlugins(ECSTATIC_ENTRY) });
      const project = join(dir, "tsconfig.json");

      const plugin = ecstatic(options(project, dir));

      expect(plugin).toStrictEqual({ name: "ttsc-vite", options: expected(project, dir) });
    });

    it("throws naming the project when it lacks the ecstatic plugin entry", () => {
      const dir = createProject({ "tsconfig.json": withPlugins(OTHER_ENTRY) });
      const project = join(dir, "tsconfig.json");

      expect(() => ecstatic({ project })).toThrow(project);
    });
  });

  describe("when no project is given", () => {
    it("returns the entry check followed by the ttsc Vite plugin", () => {
      const plugins = ecstatic();

      expect(plugins).toStrictEqual([
        expect.objectContaining({ name: expect.any(String), transform: expect.any(Function) }),
        { name: "ttsc-vite", options: {} },
      ]);
    });

    it("accepts a module whose nearest tsconfig has the ecstatic entry", () => {
      const dir = createProject({
        "tsconfig.json": withPlugins(ECSTATIC_ENTRY),
        "src/main.ts": "",
      });
      const entryCheck = createEntryCheck();

      expect(() => transformModule(entryCheck, join(dir, "src", "main.ts"))).not.toThrow();
    });

    it("checks the referenced project that compiles the module", () => {
      const dir = createProject({
        "tsconfig.json": { files: [], references: [{ path: "./tsconfig.app.json" }] },
        "tsconfig.app.json": { include: ["src"], ...withPlugins(OTHER_ENTRY) },
        "src/main.ts": "",
      });
      const entryCheck = createEntryCheck();

      expect(() => transformModule(entryCheck, join(dir, "src", "main.ts"))).toThrow(
        join(dir, "tsconfig.app.json"),
      );
    });

    it("falls back to the tsconfig in the working directory", () => {
      const moduleDir = createProject({ "main.ts": "" });
      const workingDir = createProject({ "tsconfig.json": withPlugins(OTHER_ENTRY) });
      vi.spyOn(process, "cwd").mockReturnValue(workingDir);
      const entryCheck = createEntryCheck();

      expect(() => transformModule(entryCheck, join(moduleDir, "main.ts"))).toThrow(
        join(workingDir, "tsconfig.json"),
      );
    });

    it("checks each tsconfig once", () => {
      const dir = createProject({
        "tsconfig.json": withPlugins(ECSTATIC_ENTRY),
        "a.ts": "",
        "b.ts": "",
      });
      const tsconfig = join(dir, "tsconfig.json");
      const entryCheck = createEntryCheck();
      transformModule(entryCheck, join(dir, "a.ts"));
      writeFixture(tsconfig, withPlugins(OTHER_ENTRY));

      expect(() => transformModule(entryCheck, join(dir, "b.ts"))).not.toThrow();
    });

    it.each([
      { kind: "no query or hash", suffix: "" },
      { kind: "a cache-busting query", suffix: "?t=123" },
      { kind: "a hash", suffix: "#section" },
      { kind: "a worker entry query", suffix: "?worker_file&type=module" },
      { kind: "a hash before a wrapper key", suffix: "#section?raw" },
    ])("checks the tsconfig of the underlying file for an id with $kind", ({ suffix }) => {
      const dir = createProject({ "tsconfig.json": withPlugins(OTHER_ENTRY), "src/main.ts": "" });
      const entryCheck = createEntryCheck();

      expect(() => transformModule(entryCheck, `${join(dir, "src", "main.ts")}${suffix}`)).toThrow(
        join(dir, "tsconfig.json"),
      );
    });

    it.each(["?raw", "?url", "?inline", "?no-inline", "?worker", "?sharedworker", "?v=1&raw"])(
      "ignores the host wrapper module %s, which ttsc does not transform",
      (suffix) => {
        const dir = createProject({ "tsconfig.json": withPlugins(OTHER_ENTRY), "main.ts": "" });
        const entryCheck = createEntryCheck();

        expect(() => transformModule(entryCheck, `${join(dir, "main.ts")}${suffix}`)).not.toThrow();
      },
    );

    it.each([
      { kind: "a JavaScript module", file: "main.js" },
      { kind: "a module under node_modules", file: "node_modules/dep/index.ts" },
    ])("ignores $kind, which ttsc does not transform", ({ file }) => {
      const dir = createProject({ "tsconfig.json": withPlugins(OTHER_ENTRY), [file]: "" });
      const entryCheck = createEntryCheck();

      expect(() => transformModule(entryCheck, join(dir, file))).not.toThrow();
    });
  });
});
