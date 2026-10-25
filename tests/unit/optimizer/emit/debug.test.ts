import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { sourceFileName } from "../../../../src/plugin/optimizer/compiler.js";
import { loadDebug } from "../../../../src/plugin/optimizer/emit/debug.js";
import type { Session } from "../../../../src/plugin/optimizer/session.js";
import {
  appTsconfig,
  closeProject,
  openProject,
  projectPath,
  runtimeProject,
  SPAWN_TIMEOUT_MS,
  writeProject,
} from "../project.js";

const DEBUG_FILE = "src/ecstatic/debug.ts";

const NO_DEBUG = "no top-level DEBUG declaration with an initializer";

let session: Session;

beforeAll(async () => {
  ({ session } = await openProject({
    "tsconfig.json": appTsconfig(),
    "app/main.ts": "export const main = 1;\n",
  }));
}, SPAWN_TIMEOUT_MS);

afterAll(() => closeProject(session));

describe("loadDebug", () => {
  describe("when the runtime root declares a top-level DEBUG with an initializer", () => {
    it.each([
      {
        name: "a single declaration",
        source: "export const DEBUG: boolean = !(globalThis as { NDEBUG?: unknown }).NDEBUG;\n",
        initializer: "!(globalThis as { NDEBUG?: unknown }).NDEBUG",
      },
      {
        name: "a later declaration of a list, after other statements",
        source:
          "export function checks(): boolean {\n    return true;\n}\nlet ready = 1, DEBUG = ready > 0;\n",
        initializer: "ready > 0",
      },
    ])("copies the initializer of $name", async ({ source, initializer }) => {
      const root = writeProject({ [DEBUG_FILE]: source });

      const debug = await loadDebug(session, root);

      expect(sourceFileName(debug.getSourceFile())).toBe(projectPath(root, DEBUG_FILE));
      expect(debug.getText()).toBe(initializer);
    });

    it("copies the initializer from the runtime's own debug module", async () => {
      const root = writeProject(runtimeProject());

      const debug = await loadDebug(session, root);

      const declaration = debug.parent.getText();
      expect(sourceFileName(debug.getSourceFile())).toBe(projectPath(root, DEBUG_FILE));
      expect(declaration).toMatch(/^DEBUG\b/u);
      expect(declaration.endsWith(`= ${debug.getText()}`)).toBe(true);
    });
  });

  describe("when the runtime root has no DEBUG initializer to copy", () => {
    it("rejects naming the file when it cannot be read", async () => {
      const root = writeProject({ "src/ecstatic/index.ts": "export {};\n" });

      const loading = loadDebug(session, root);

      await expect(loading).rejects.toThrow(projectPath(root, DEBUG_FILE));
    });

    it.each([
      { name: "no DEBUG declared", source: "export const CHECKS = true;\n" },
      {
        name: "DEBUG declared without an initializer",
        source: "export declare const DEBUG: boolean;\n",
      },
      {
        name: "DEBUG declared only inside a function",
        source:
          "export function checks(): boolean {\n    const DEBUG = true;\n    return DEBUG;\n}\n",
      },
      {
        name: "DEBUG bound only by destructuring",
        source: "export const { DEBUG } = { DEBUG: true };\n",
      },
    ])("rejects naming the file when it has $name", async ({ source }) => {
      const root = writeProject({ [DEBUG_FILE]: source });
      const path = projectPath(root, DEBUG_FILE);

      const loading = loadDebug(session, root);

      await expect(loading).rejects.toThrow(`${path}: ${NO_DEBUG}`);
    });
  });
});
