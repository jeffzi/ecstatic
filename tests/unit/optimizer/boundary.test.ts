import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  type BoundaryChecker,
  type Module,
  OPTIMIZER_RULES,
  openBoundaryChecker,
  readModules,
} from "./boundary.js";
import { removeProjects, SPAWN_TIMEOUT_MS, writeProject } from "./project.js";

const OPTIMIZER_DIR = fileURLToPath(new URL("../../../src/plugin/optimizer/", import.meta.url));

const TSGO = "only compiler.ts reaches tsgo";
const EMIT = "emit imports nothing from analysis";
const SYNTAX = "syntax.ts imports nothing from emit";

/** A compiler module reaching tsgo, as only it may, and re-exporting the API types others use. */
const COMPILER: Module = {
  path: "compiler.ts",
  text: [
    'import type { API } from "typescript/sync";',
    'import type { Checker, Symbol } from "typescript/async";',
    'import type { Node } from "typescript/ast";',
    'export type { Node } from "typescript/ast";',
    "export type {",
    "  BuildOrchestrator,",
    "  Checker,",
    "  LanguageService,",
    "  ModuleResolver,",
    "  Printer,",
    "  Project,",
    "  RetainedSourceFile,",
    "  Snapshot,",
    "  Type,",
    '} from "typescript/async";',
    'export type { Project as SyncProject } from "typescript/sync";',
    "export type CheckerSymbol = Symbol;",
    "export const typeOf = (checker: Checker, node: Node) => checker.getTypeAtLocation(node);",
    "export const text = (api: API, node: Node) => api.printer.printNode(node);",
  ].join("\n"),
};

/** Modules that keep every optimizer boundary. */
const CLEAN: readonly Module[] = [
  COMPILER,
  { path: "facts.ts", text: "export interface Fact { readonly id: number }\n" },
  { path: "fold.ts", text: 'import type { Fact } from "./facts.js";\n' },
  { path: "plan.ts", text: 'import type { Fact } from "./facts.js";\n' },
  { path: "syntax.ts", text: "export const isLabel = (text: string): boolean => text !== '';\n" },
];

/** A module at `path` whose text is `lines` joined by newlines. */
function source(path: string, ...lines: string[]): Module {
  return { path, text: lines.join("\n") };
}

/** {@link CLEAN} without the module at `path`. */
function without(path: string): Module[] {
  return CLEAN.filter((clean) => clean.path !== path);
}

/** {@link CLEAN} with `module` added, or replacing the clean module at its path. */
function withModule(module: Module): Module[] {
  return [...without(module.path), module];
}

let boundaries: BoundaryChecker;

beforeAll(() => {
  boundaries = openBoundaryChecker();
}, SPAWN_TIMEOUT_MS);

afterAll(() => {
  boundaries.close();
  removeProjects();
});

describe("optimizer boundaries", () => {
  describe("over the optimizer sources", () => {
    it("finds no violation", () => {
      const violations = boundaries.checkDirectory(OPTIMIZER_DIR, OPTIMIZER_RULES);

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
        module: source(
          "analysis/types.ts",
          'import type { Checker, Node } from "../compiler.js";',
          "export const typeOf = (c: Checker, n: Node) => c.getTypeAtLocation(n);",
        ),
        expected: [`analysis/types.ts:2 calls getTypeAtLocation: ${TSGO}`],
      },
      {
        name: "a module calls a symbol method",
        module: source(
          "nodes.ts",
          'import type { CheckerSymbol } from "./compiler.js";',
          "export const members = (sym: CheckerSymbol) => sym.getMembers();",
        ),
        expected: [`nodes.ts:2 calls getMembers: ${TSGO}`],
      },
      {
        name: "a module calls a type method",
        module: source(
          "nodes.ts",
          'import type { Type } from "./compiler.js";',
          "export const calls = (t: Type) => t.getCallSignatures();",
        ),
        expected: [`nodes.ts:2 calls getCallSignatures: ${TSGO}`],
      },
      {
        name: "a module calls a snapshot method",
        module: source(
          "nodes.ts",
          'import type { Snapshot } from "./compiler.js";',
          "export const projects = (s: Snapshot) => s.getProjects();",
        ),
        expected: [`nodes.ts:2 calls getProjects: ${TSGO}`],
      },
      {
        name: "a module calls a method through a snapshot",
        module: source(
          "nodes.ts",
          'import type { Snapshot } from "./compiler.js";',
          "export const projects = (s: { snapshot: Snapshot }) => s.snapshot.getProjects();",
        ),
        expected: [`nodes.ts:2 calls getProjects: ${TSGO}`, `nodes.ts:2 reads snapshot: ${TSGO}`],
      },
      {
        name: "a module calls the printer",
        module: source(
          "emit/print.ts",
          'import type { Node, Printer } from "../compiler.js";',
          "export const text = (p: Printer, n: Node) => p.printNode(n);",
        ),
        expected: [`emit/print.ts:2 calls printNode: ${TSGO}`],
      },
      {
        name: "a module resolves a declaration handle of a re-exported symbol type",
        module: source(
          "analysis/roots.ts",
          'import type { CheckerSymbol } from "../compiler.js";',
          "export const declaration = (sym: CheckerSymbol) => sym.valueDeclaration?.resolve();",
        ),
        expected: [`analysis/roots.ts:2 calls resolve: ${TSGO}`],
      },
      {
        name: "a module calls a project method",
        module: source(
          "nodes.ts",
          'import type { Project } from "./compiler.js";',
          "export const drop = (p: Project) => p.dispose();",
        ),
        expected: [`nodes.ts:2 calls dispose: ${TSGO}`],
      },
      {
        name: "a module calls a project method of the synchronous API",
        module: source(
          "nodes.ts",
          'import type { SyncProject } from "./compiler.js";',
          "export const drop = (p: SyncProject) => p.dispose();",
        ),
        expected: [`nodes.ts:2 calls dispose: ${TSGO}`],
      },
      {
        name: "a module calls a language service method",
        module: source(
          "nodes.ts",
          'import type { LanguageService, Node } from "./compiler.js";',
          "export const usage = (ls: LanguageService, n: Node) => ls.getSignatureUsage(n);",
        ),
        expected: [`nodes.ts:2 calls getSignatureUsage: ${TSGO}`],
      },
      {
        name: "a module calls a module resolver method",
        module: source(
          "nodes.ts",
          'import type { ModuleResolver } from "./compiler.js";',
          "export const drop = (r: ModuleResolver) => r.dispose();",
        ),
        expected: [`nodes.ts:2 calls dispose: ${TSGO}`],
      },
      {
        name: "a module calls a retained source file method",
        module: source(
          "nodes.ts",
          'import type { RetainedSourceFile } from "./compiler.js";',
          "export const drop = (f: RetainedSourceFile) => f.dispose();",
        ),
        expected: [`nodes.ts:2 calls dispose: ${TSGO}`],
      },
      {
        name: "a module calls a build orchestrator method",
        module: source(
          "nodes.ts",
          'import type { BuildOrchestrator } from "./compiler.js";',
          "export const run = (b: BuildOrchestrator) => b.build();",
        ),
        expected: [`nodes.ts:2 calls build: ${TSGO}`],
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
        expected: [expect.stringMatching(/^facts\.ts:1 imports typescript\/ast: /u)],
      },
      {
        name: "plan.ts imports typescript",
        module: { path: "plan.ts", text: 'import { version } from "typescript";' },
        expected: [expect.stringMatching(/^plan\.ts:1 imports typescript: /u)],
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
      {
        name: "syntax.ts imports an emit module",
        module: { path: "syntax.ts", text: 'import type { Rule } from "./emit/catalog.js";' },
        expected: [`syntax.ts:1 imports ./emit/catalog.js: ${SYNTAX}`],
      },
    ])("reports it when $name", ({ module, expected }) => {
      const violations = boundaries.checkModules(withModule(module), OPTIMIZER_RULES);

      expect(violations).toStrictEqual(expected);
    });
  });

  describe("when a module keeps every boundary", () => {
    it.each<{ name: string; module: Module }>([
      { name: "only compiler.ts reaches tsgo", module: COMPILER },
      {
        name: "a comment and a string mention tsgo calls",
        module: source(
          "nodes.ts",
          "// checker.getTypeAtLocation(node)",
          'export const hint = "printNode(x) from typescript/sync";',
        ),
      },
      {
        name: "a module imports the compiler module",
        module: { path: "nodes.ts", text: 'import { typeOf } from "./compiler.js";' },
      },
      {
        name: "a module calls node and project view methods the compiler also declares",
        module: source(
          "nodes.ts",
          "export const text = (node) => node.getSourceFile().getText();",
          "export const refresh = (view, changes) => view.update(changes).emit();",
        ),
      },
      {
        name: "a module calls Promise.resolve",
        module: { path: "session.ts", text: "export const ready = () => Promise.resolve(1);" },
      },
      {
        name: "a module calls its own methods named like compiler methods",
        module: source(
          "emit/emit.ts",
          "class Loop {",
          "  static build(): Loop { return new Loop(); }",
          "  resolve(): number { return 1; }",
          "}",
          "export const made = Loop.build().resolve();",
        ),
      },
      {
        name: "a module calls a method of its own type named like a compiler class",
        module: source(
          "nodes.ts",
          "interface Snapshot { getProjects(): readonly string[] }",
          "export const projects = (s: Snapshot) => s.getProjects();",
        ),
      },
      {
        name: "a module other than facts.ts, fold.ts, and plan.ts imports typescript/ast",
        module: { path: "nodes.ts", text: 'import type { Node } from "typescript/ast";' },
      },
      {
        name: "an emit module imports its siblings and the shared modules",
        module: source(
          "emit/emit.ts",
          'import { names } from "./names.js";',
          'import { lower } from "./loops/lowering.js";',
          'import { printNode } from "../compiler.js";',
          'import type { Fact } from "../facts.js";',
          'import type { Plan } from "../plan.js";',
          'import { analysisNote } from "../analysis-note.js";',
        ),
      },
      {
        name: "a module outside emit imports an analysis module",
        module: { path: "pipeline.ts", text: 'import { analyze } from "./analysis/analyze.js";' },
      },
    ])("reports nothing when $name", ({ module }) => {
      const violations = boundaries.checkModules(withModule(module), OPTIMIZER_RULES);

      expect(violations).toStrictEqual([]);
    });
  });

  describe("when a module the rules name is missing", () => {
    it("reports compiler.ts", () => {
      const violations = boundaries.checkModules(without("compiler.ts"), OPTIMIZER_RULES);

      expect(violations).toStrictEqual([expect.stringMatching(/^compiler\.ts is missing: /u)]);
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
