import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, it } from "vitest";

import { checkBoundaries, type Module, OPTIMIZER_RULES, readModules } from "./boundary.js";
import { removeProjects, writeProject } from "./project.js";

const OPTIMIZER_DIR = fileURLToPath(new URL("../../../src/plugin/optimizer/", import.meta.url));

const TSGO = "only compiler.ts reaches tsgo";
const PURE = "facts.ts and plan.ts import nothing from typescript";
const EMIT = "emit imports nothing from analysis";

/** A compiler module reaching tsgo, as only it may. */
const COMPILER: Module = {
  path: "compiler.ts",
  text: [
    'import { API } from "typescript/sync";',
    'import type { Checker } from "typescript/async";',
    "export const typeOf = (checker: Checker, node: Node) => checker.getTypeAtLocation(node);",
    "export const text = (node: Node) => printNode(node);",
  ].join("\n"),
};

/** Modules that keep every optimizer boundary. */
const CLEAN: readonly Module[] = [
  COMPILER,
  { path: "facts.ts", text: "export interface Fact { readonly id: number }\n" },
  { path: "plan.ts", text: 'import type { Fact } from "./facts.js";\n' },
];

/** {@link CLEAN} with `module` added, or replacing the clean module at its path. */
function withModule(module: Module): Module[] {
  return [...CLEAN.filter((clean) => clean.path !== module.path), module];
}

afterAll(removeProjects);

describe("optimizer boundaries", () => {
  describe("over the optimizer sources", () => {
    it("finds no violation", () => {
      const modules = readModules(OPTIMIZER_DIR);

      const violations = checkBoundaries(modules, OPTIMIZER_RULES);

      expect(violations).toStrictEqual([]);
    });
  });

  describe("when a module breaks a boundary", () => {
    it.each<{ name: string; module: Module; expected: string[] }>([
      {
        name: "a module imports typescript/sync",
        module: { path: "nodes.ts", text: 'import { API } from "typescript/sync";' },
        expected: [`nodes.ts:1 imports typescript/sync: ${TSGO}`],
      },
      {
        name: "a module type-imports typescript/async",
        module: {
          path: "nodes.ts",
          text: '\nimport type { Checker } from "typescript/async";',
        },
        expected: [`nodes.ts:2 imports typescript/async: ${TSGO}`],
      },
      {
        name: "a module re-exports from typescript/async",
        module: { path: "nodes.ts", text: 'export type { Type } from "typescript/async";' },
        expected: [`nodes.ts:1 imports typescript/async: ${TSGO}`],
      },
      {
        name: "a module dynamically imports typescript/sync",
        module: { path: "nodes.ts", text: 'const api = await import("typescript/sync");' },
        expected: [`nodes.ts:1 imports typescript/sync: ${TSGO}`],
      },
      {
        name: "a nested module calls a checker method",
        module: {
          path: "analysis/types.ts",
          text: "export const typeOf = (c, n) => c.getTypeAtLocation(n);",
        },
        expected: [`analysis/types.ts:1 calls getTypeAtLocation: ${TSGO}`],
      },
      {
        name: "a module calls a checker method on any variable",
        module: {
          path: "nodes.ts",
          text: "export const expected = (c, n) => c.getContextualType(n);",
        },
        expected: [`nodes.ts:1 calls getContextualType: ${TSGO}`],
      },
      {
        name: "a module calls a symbol method",
        module: { path: "nodes.ts", text: "export const members = (sym) => sym.getMembers();" },
        expected: [`nodes.ts:1 calls getMembers: ${TSGO}`],
      },
      {
        name: "a module calls a type method",
        module: {
          path: "nodes.ts",
          text: "export const calls = (t) => t.getCallSignatures();",
        },
        expected: [`nodes.ts:1 calls getCallSignatures: ${TSGO}`],
      },
      {
        name: "a module calls a snapshot method on any variable",
        module: { path: "nodes.ts", text: "export const projects = (s) => s.getProjects();" },
        expected: [`nodes.ts:1 calls getProjects: ${TSGO}`],
      },
      {
        name: "a module calls a method through a snapshot",
        module: {
          path: "nodes.ts",
          text: "export const projects = (s) => s.snapshot.getProjects();",
        },
        expected: [`nodes.ts:1 calls getProjects: ${TSGO}`, `nodes.ts:1 reads snapshot: ${TSGO}`],
      },
      {
        name: "a module calls the printer",
        module: { path: "emit/print.ts", text: "export const text = (n) => printNode(n);" },
        expected: [`emit/print.ts:1 calls printNode: ${TSGO}`],
      },
      {
        name: "a module reads through a program",
        module: { path: "nodes.ts", text: "export const files = (s) => s.program.files;" },
        expected: [`nodes.ts:1 reads program: ${TSGO}`],
      },
      {
        name: "a module reads through a checker",
        module: {
          path: "nodes.ts",
          text: "export const typeOf = (s, n) => s.checker.typeOfNode(n);",
        },
        expected: [`nodes.ts:1 reads checker: ${TSGO}`],
      },
      {
        name: "facts.ts imports typescript/ast",
        module: { path: "facts.ts", text: 'import type { Node } from "typescript/ast";' },
        expected: [`facts.ts:1 imports typescript/ast: ${PURE}`],
      },
      {
        name: "plan.ts imports typescript",
        module: { path: "plan.ts", text: 'import { version } from "typescript";' },
        expected: [`plan.ts:1 imports typescript: ${PURE}`],
      },
      {
        name: "an emit module imports an analysis module",
        module: { path: "emit/print.ts", text: 'import { typeOf } from "../analysis/types.js";' },
        expected: [`emit/print.ts:1 imports ../analysis/types.js: ${EMIT}`],
      },
      {
        name: "a nested emit module type-imports a nested analysis module",
        module: {
          path: "emit/loops/body.ts",
          text: '\nimport type { Read } from "../../analysis/reads/field.js";',
        },
        expected: [`emit/loops/body.ts:2 imports ../../analysis/reads/field.js: ${EMIT}`],
      },
      {
        name: "an emit module reaches analysis through a detour",
        module: {
          path: "emit/print.ts",
          text: 'import { site } from "./../emit/../analysis/site.js";',
        },
        expected: [`emit/print.ts:1 imports ./../emit/../analysis/site.js: ${EMIT}`],
      },
      {
        name: "an emit module re-exports from an analysis module",
        module: { path: "emit/emit.ts", text: 'export type { Site } from "../analysis/site.js";' },
        expected: [`emit/emit.ts:1 imports ../analysis/site.js: ${EMIT}`],
      },
      {
        name: "an emit module dynamically imports an analysis module",
        module: {
          path: "emit/emit.ts",
          text: 'const analysis = await import("../analysis/analyze.js");',
        },
        expected: [`emit/emit.ts:1 imports ../analysis/analyze.js: ${EMIT}`],
      },
    ])("reports it when $name", ({ module, expected }) => {
      const violations = checkBoundaries(withModule(module), OPTIMIZER_RULES);

      expect(violations).toStrictEqual(expected);
    });
  });

  describe("when a module keeps every boundary", () => {
    it.each<{ name: string; module: Module }>([
      { name: "only compiler.ts reaches tsgo", module: COMPILER },
      {
        name: "a comment and a string mention tsgo calls",
        module: {
          path: "nodes.ts",
          text: [
            "// checker.getTypeAtLocation(node)",
            'export const hint = "printNode(x) from typescript/sync";',
          ].join("\n"),
        },
      },
      {
        name: "a module imports the compiler module",
        module: { path: "nodes.ts", text: 'import { typeOf } from "./compiler.js";' },
      },
      {
        name: "a module calls node and project view methods the compiler also declares",
        module: {
          path: "nodes.ts",
          text: [
            "export const text = (node) => node.getSourceFile().getText();",
            "export const refresh = (view, changes) => view.update(changes).emit();",
          ].join("\n"),
        },
      },
      {
        name: "a module other than facts.ts and plan.ts imports typescript/ast",
        module: { path: "nodes.ts", text: 'import type { Node } from "typescript/ast";' },
      },
      {
        name: "an emit module imports its siblings and the shared modules",
        module: {
          path: "emit/emit.ts",
          text: [
            'import { names } from "./names.js";',
            'import { lower } from "./loops/lowering.js";',
            'import { printNode } from "../compiler.js";',
            'import type { Fact } from "../facts.js";',
            'import type { Plan } from "../plan.js";',
            'import { analysisNote } from "../analysis-note.js";',
          ].join("\n"),
        },
      },
      {
        name: "a module outside emit imports an analysis module",
        module: { path: "pipeline.ts", text: 'import { analyze } from "./analysis/analyze.js";' },
      },
    ])("reports nothing when $name", ({ module }) => {
      const violations = checkBoundaries(withModule(module), OPTIMIZER_RULES);

      expect(violations).toStrictEqual([]);
    });
  });

  describe("when a module the rules name is missing", () => {
    it.each(["compiler.ts", "facts.ts", "plan.ts"])("reports %s", (path) => {
      const modules = CLEAN.filter((module) => module.path !== path);

      const violations = checkBoundaries(modules, OPTIMIZER_RULES);

      expect(violations).toStrictEqual([`${path} is missing: the boundary rules name it`]);
    });
  });
});

describe("readModules", () => {
  it("reads every TypeScript module under the directory except tests", () => {
    const dir = writeProject({
      "a.ts": "export const a = 1;",
      "sub/b.ts": "export const b = 2;",
      "a.test.ts": "",
      "notes.md": "",
    });

    const modules = readModules(dir);

    expect(modules).toStrictEqual([
      { path: "a.ts", text: "export const a = 1;" },
      { path: "sub/b.ts", text: "export const b = 2;" },
    ]);
  });
});
