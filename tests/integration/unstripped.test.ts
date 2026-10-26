import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { Expression, SourceFile } from "typescript/ast";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { analyze } from "../../src/plugin/optimizer/analysis/analyze.js";
import { sourceFileName } from "../../src/plugin/optimizer/compiler.js";
import { compareCodeUnits, type Reason, type Site } from "../../src/plugin/optimizer/facts.js";
import { plan, type PlanResult } from "../../src/plugin/optimizer/plan.js";
import {
  createRewriter,
  type Rewriter,
  type RewriteSeams,
  type RewrittenModule,
} from "../../src/plugin/optimizer/rewrite.js";
import { openSession, type ProjectView, type Session } from "../../src/plugin/optimizer/session.js";
import {
  closeProject,
  openProject,
  projectPath,
  relativePath,
  runtimeProject,
  SPAWN_TIMEOUT_MS,
} from "../unit/optimizer/project.js";
import { flattenSites } from "../unit/optimizer/sites.js";
import { REPO_ROOT } from "../unit/plugin/tsconfig-fixtures.js";
import {
  NO_FILTER_GUARDS,
  NO_SHAPE_GUARDS,
  runtimeDebug,
  unstrippedProblems,
} from "./unstripped.js";

/** The project the optimized unit projects hand `ecstatic/vite`. */
const TESTS_TSCONFIG = join(REPO_ROOT, "tests", "tsconfig.json");

/** How long rewriting every module the optimized unit projects run may take on a slow CI runner. */
const REWRITE_TIMEOUT_MS = 60_000;

/**
 * The optimizer's corpus and tests, which no optimized unit project runs. Every other module of the
 * tests' program is checked: a superset of what those projects transform, helpers they import from
 * `scripts/` and `tests/unit/optimizer/` included.
 */
const INTEGRATION_TESTS = "tests/integration/";

/** The directory of the unit suite, whose filtered each calls the kept-calls census reads. */
const UNIT_TESTS = "tests/unit/";

/** Modules outside the runtime unit tests that the optimized unit projects still transform. */
const TRANSFORMED_HELPERS = [
  "scripts/caught.ts",
  "scripts/check-coverage-fresh.ts",
  "scripts/sync-version.ts",
  "tests/package-bin.ts",
  "tests/skip-checked.ts",
  "tests/unit/optimizer/processes.ts",
  "tests/unit/optimizer/project.ts",
];

/** A module whose `each` calls compile to inlined loops, in a project holding a runtime copy. */
const MAIN_MODULE = "app/main.ts";

/** A module that binds `DEBUG` itself, beside the guards the emitter writes. */
const FLAGS_MODULE = "app/flags.ts";

/**
 * A module whose inlined loops guard the iterated storage, in `trail` a spawn into another storage,
 * and in `seek` the elements of a literal filter.
 */
const INLINED_SOURCE = `import { archetype, component, each, spawn, type Storage } from "../src/ecstatic/index.js";

const Position = component("Position", { x: 0, y: 0 });
const Mark = component("Mark", { at: 0 });
const Mover = archetype([Position]);
const Trail = archetype([Mark]);

export function advance(movers: Storage<typeof Mover>): void {
  each(movers, (e) => {
    e.Position.x += 1;
  });
}

export function trail(movers: Storage<typeof Mover>, marks: Storage<typeof Trail>): void {
  each(movers, (e) => {
    spawn(marks);
    e.Position.x += 1;
  });
}

export function seek(movers: Storage<typeof Mover>): void {
  each(movers, { all: [Position], none: [Mark] }, (e) => {
    e.Position.x += 1;
  });
}
`;

/** The `src/ecstatic/debug.ts` the rejecting cases compare gates with. */
const CHECKER_RUNTIME = `declare const NDEBUG: boolean | undefined;
export const DEBUG = typeof NDEBUG === "undefined" || !NDEBUG;
`;

/** The initializer of `DEBUG` in {@link CHECKER_RUNTIME}. */
const CHECKER_GATE = 'typeof NDEBUG === "undefined" || !NDEBUG';

const SHAPE_KEY = "c8:Position{1:x=n,1:y=n}|";

const BARE_GUARD = `ecstatic_internal.assertShape(storage, "${SHAPE_KEY}");`;

/** A shape guard gated by {@link CHECKER_GATE}, as the emitter writes one. */
const GATED_GUARD = `(${CHECKER_GATE}) && ${BARE_GUARD}`;

/** Two filter-element guards in a parenthesized comma list, as the emitter writes several. */
const FILTER_LIST =
  "(ecstatic_internal.assertFilterMember(storage, element, true), ecstatic_internal.assertFilterMember(storage, element, false))";

/** A comma list of filter-element guards gated by {@link CHECKER_GATE}, as the emitter writes one. */
const GATED_FILTER_GUARD = `(${CHECKER_GATE}) && ${FILTER_LIST};`;

/** The test module the rejecting cases write their outputs as. */
const REJECTED_MODULE = "tests/unit/a.test.ts";

/** The test module beside a rejecting case's outputs that holds a gated filter-element guard. */
const GATED_MODULE = "tests/unit/gated.test.ts";

/** The problem named for a guard on line 4 of {@link REJECTED_MODULE} whose gate reads an `NDEBUG` the file binds. */
const SHADOWED = `${REJECTED_MODULE}:4: the shape guard is gated by ${CHECKER_GATE} (reading the file's own NDEBUG), not by the runtime's DEBUG initializer`;

/** The problem named for a shape guard on line 4 of {@link REJECTED_MODULE} gated by `gate` alone. */
function gatedOtherwise(gate: string): string {
  return `${REJECTED_MODULE}:4: the shape guard is gated by ${gate}, not by the runtime's DEBUG initializer`;
}

/**
 * A filtered each call that keeps its runtime call: the slash-separated file relative to the
 * repository, the 1-based line of the call, and the reason the plan gives, `undefined` when the plan
 * neither rewrites nor bails it.
 */
interface KeptCall {
  readonly file: string;
  readonly line: number;
  readonly reason: Reason | undefined;
}

/** The sites of one analyzed file and the plan made for them. */
interface Analyzed {
  readonly sites: readonly Site[];
  readonly plan: PlanResult;
}

/** What the rewriter's analysis gave, keyed by file, recorded as each file is rewritten. */
const analyzed = new Map<string, Analyzed>();

const seams: RewriteSeams = {
  analyze: async (checker, source, roots) => {
    const analysis = await analyze(checker, source, roots);
    analyzed.set(sourceFileName(source), { sites: analysis.sites, plan: plan(analysis.sites) });
    return analysis;
  },
};

let session: Session;
let rewriter: Rewriter;
let runtime: Expression;
let checkerRuntime: Expression;

beforeAll(async () => {
  session = await openSession(TESTS_TSCONFIG);
  rewriter = createRewriter(session, seams);
  runtime = runtimeDebug(await session.parse(join(REPO_ROOT, "src", "ecstatic", "debug.ts")));
  checkerRuntime = runtimeDebug(
    await session.parseText(
      join(REPO_ROOT, "tests", "integration", "checker-debug.ts"),
      CHECKER_RUNTIME,
    ),
  );
}, SPAWN_TIMEOUT_MS);

afterAll(async () => {
  await session.close();
});

/** The output of a rewritten module that declares `declarations` on line 2 and whose function holds `guard` on line 4. */
function guardedModule(declarations: string, guard: string): string {
  return `import * as ecstatic_internal from "ecstatic/internal";
${declarations}
export function run(storage: unknown): void {
  ${guard}
}
`;
}

/** The slash-separated path of `file` from the repository root. */
function repoName(file: string): string {
  return relativePath(REPO_ROOT, file);
}

/** Parses each output of `outputs`, keyed by slash-separated path from the repository root. */
async function parsed(outputs: Readonly<Record<string, string>>): Promise<Map<string, SourceFile>> {
  const entries = await Promise.all(
    Object.entries(outputs).map(
      async ([name, text]) =>
        [name, await session.parseText(projectPath(REPO_ROOT, name), text)] as const,
    ),
  );
  return new Map(entries);
}

/** The problems with `outputs`, checked against the DEBUG initializer of {@link CHECKER_RUNTIME}. */
async function checkerProblems(outputs: Readonly<Record<string, string>>): Promise<string[]> {
  return unstrippedProblems(await parsed(outputs), checkerRuntime);
}

/** The problems with `outputs` beside {@link GATED_MODULE}, so no filter-element guard is missing. */
async function gatingProblems(outputs: Readonly<Record<string, string>>): Promise<string[]> {
  return await checkerProblems({
    [GATED_MODULE]: guardedModule("", GATED_FILTER_GUARD),
    ...outputs,
  });
}

/** The text `by` rewrites `file` to in `view`, failing when it leaves the module unchanged. */
async function rewrittenText(by: Rewriter, view: ProjectView, file: string): Promise<string> {
  const { output } = await by.rewrite(view, file);
  if (output === undefined) throw new Error(`${file} was left unchanged by the optimizer`);
  return output.text;
}

/** Whether `site` is an each call over one storage, with a filter and an inline callback. */
function isFilteredInlineEach(site: Site): boolean {
  return (
    site.op === "each" &&
    site.filter !== undefined &&
    !site.arrayLiteral &&
    site.callback !== undefined
  );
}

/**
 * Every filtered single-storage each call of the unit suite with an inline callback that keeps its
 * runtime call in the output of `modules`, nested calls included: one its plan bails on, one whose
 * planned rewrite failed to emit, and one the plan neither rewrites nor bails on.
 *
 * @param modules - The rewritten modules, keyed by file; their sites and plans come from
 *   {@link analyzed}.
 * @returns Each such call with the reason its module's bail gives, sorted by file then line.
 */
function keptFilteredCalls(modules: ReadonlyMap<string, RewrittenModule>): KeptCall[] {
  return [...modules]
    .filter(([file]) => repoName(file).startsWith(UNIT_TESTS))
    .flatMap(([file, { bails }]) => {
      const record = analyzed.get(file);
      const rewritten = new Set(record?.plan.rewrites.map(({ call }) => call));
      const bailed = new Map(bails.map((bail) => [bail.call, bail]));
      const keepsCall = (call: Site["call"]): boolean => bailed.has(call) || !rewritten.has(call);
      return flattenSites(record?.sites ?? [])
        .filter((site) => isFilteredInlineEach(site) && keepsCall(site.call))
        .map((site) => ({
          file: repoName(file),
          line: site.pos.line,
          reason: bailed.get(site.call)?.reason,
        }));
    })
    .toSorted((a, b) => (a.file === b.file ? a.line - b.line : compareCodeUnits(a.file, b.file)));
}

/**
 * The kept call the one occurrence of a snippet opens in a repository file, which its plan bails on
 * as `OP_NOT_REWRITTEN`.
 *
 * @param file - The slash-separated path of the file, relative to the repository.
 * @param snippet - The source text that opens the call.
 * @returns The kept call, on the 1-based line where `snippet` starts.
 * @throws When `snippet` occurs in `file` zero times or more than once.
 */
function keptCall(file: string, snippet: string): KeptCall {
  const text = readFileSync(join(REPO_ROOT, file), "utf8");
  if (text.split(snippet).length !== 2) throw new Error(`${file} must hold one ${snippet}`);
  const line = text.slice(0, text.indexOf(snippet)).split("\n").length;
  return { file, line, reason: "OP_NOT_REWRITTEN" };
}

describe("unstrippedProblems", () => {
  describe("over the modules the optimized unit projects transform", () => {
    let checked: string[];
    let modules: Map<string, RewrittenModule>;
    let outputs: Map<string, SourceFile>;

    beforeAll(async () => {
      const view = await session.update();
      const files = (await view.sourceFileNames()).filter((file) => {
        const name = repoName(file);
        return !name.startsWith(INTEGRATION_TESTS);
      });
      checked = files.map(repoName);
      modules = new Map(
        await Promise.all(
          files.map(async (file) => [file, await rewriter.rewrite(view, file)] as const),
        ),
      );
      const rewritten = [...modules].flatMap(([file, { output }]) =>
        output === undefined ? [] : [[repoName(file), output.text] as const],
      );
      outputs = await parsed(Object.fromEntries(rewritten));
    }, REWRITE_TIMEOUT_MS);

    it("checks the helpers the runtime unit tests import from outside them", () => {
      expect(checked).toStrictEqual(expect.arrayContaining(TRANSFORMED_HELPERS));
    });

    // The kept calls, sorted by file then line, each located by the source snippet that opens it:
    // a number as the filter matches no filter form, and the outer call holds an inlined each.
    it("rewrites every filtered single-storage each with an inline callback but the kept ones", () => {
      const expected = [
        keptCall("tests/unit/entity/each.test.ts", "each(storage, 42,"),
        keptCall("tests/unit/filter.test.ts", "each(storage, { all: [Stunned] }, (outer) =>"),
      ];

      const kept = keptFilteredCalls(modules);

      expect(kept).toStrictEqual(expected);
    });

    it("finds every shape guard gated by the runtime's DEBUG initializer", () => {
      const problems = unstrippedProblems(outputs, runtime);

      expect(problems).toStrictEqual([]);
    });
  });

  describe("when every guard is gated by the runtime's DEBUG initializer", () => {
    let emitted: { main: string; flags: string };

    beforeAll(async () => {
      // The modules sit on disk: a session serves text in place of a file's, and a file the disk
      // lacks joins the program on some platforms only.
      const project = await openProject(
        runtimeProject({
          [MAIN_MODULE]: INLINED_SOURCE,
          [FLAGS_MODULE]: `${INLINED_SOURCE}export const DEBUG = false;\n`,
        }),
      );
      try {
        const projectRewriter = createRewriter(project.session);
        const rewritten = async (rel: string): Promise<string> =>
          await rewrittenText(projectRewriter, project.view, projectPath(project.root, rel));
        const [main, flags] = await Promise.all([rewritten(MAIN_MODULE), rewritten(FLAGS_MODULE)]);
        emitted = { main, flags };
      } finally {
        await closeProject(project.session);
      }
    }, SPAWN_TIMEOUT_MS);

    it.each([
      {
        name: "the guards the emitter writes",
        outputs: (): Record<string, string> => ({ [MAIN_MODULE]: emitted.main }),
      },
      {
        name: "the guards the emitter writes beside the module's own DEBUG",
        outputs: (): Record<string, string> => ({ [FLAGS_MODULE]: emitted.flags }),
      },
      {
        name: "a guard with no gate under src/ beside the guards the emitter writes",
        outputs: (): Record<string, string> => ({
          [MAIN_MODULE]: emitted.main,
          "src/each.ts": guardedModule("", BARE_GUARD),
        }),
      },
    ])("reports nothing for $name", async ({ outputs }) => {
      const files = await parsed(outputs());

      const problems = unstrippedProblems(files, runtime);

      expect(problems).toStrictEqual([]);
    });

    it("emits a spawn-target guard for the scan to check", () => {
      expect(emitted.main).toMatch(/assertShape\(target(?:_\d+)?, /u);
    });

    it.each([
      {
        name: "a gate in more parentheses",
        declarations: "",
        guard: `((${CHECKER_GATE})) && ${BARE_GUARD}`,
      },
      {
        name: "a gate after another gate",
        declarations: "const enabled = true;",
        guard: `enabled && ${GATED_GUARD}`,
      },
      {
        name: "a gate inside a parenthesized chain of gates",
        declarations: "const enabled = true;",
        guard: `(enabled && (${CHECKER_GATE})) && ${BARE_GUARD}`,
      },
    ])("reports nothing for $name", async ({ declarations, guard }) => {
      const problems = await gatingProblems({
        [REJECTED_MODULE]: guardedModule(declarations, guard),
      });

      expect(problems).toStrictEqual([]);
    });
  });

  describe("when the file binds a name the gate reads", () => {
    it.each([
      { binding: "top-level const", declarations: "const NDEBUG = false;", guard: GATED_GUARD },
      {
        binding: "named import",
        declarations: 'import { NDEBUG } from "./flags.js";',
        guard: GATED_GUARD,
      },
      { binding: "function parameter", guard: `function f(NDEBUG: boolean) { ${GATED_GUARD} }` },
      {
        binding: "destructured parameter",
        guard: `function f({ NDEBUG }: { NDEBUG: boolean }) { ${GATED_GUARD} }`,
      },
      { binding: "block-scoped const", guard: `{ const NDEBUG = true; ${GATED_GUARD} }` },
      { binding: "hoisted var", guard: `function f() { ${GATED_GUARD} var NDEBUG = true; }` },
      { binding: "catch clause", guard: `try { throw true; } catch (NDEBUG) { ${GATED_GUARD} }` },
      { binding: "class name", guard: `void class NDEBUG { static { ${GATED_GUARD} } };` },
      { binding: "function expression name", guard: `void function NDEBUG() { ${GATED_GUARD} };` },
      { binding: "for-of const", guard: `for (const NDEBUG of [true]) ${GATED_GUARD}` },
      { binding: "block-scoped let", guard: `{ let NDEBUG = true; ${GATED_GUARD} }` },
      { binding: "block function declaration", guard: `{ function NDEBUG() {} ${GATED_GUARD} }` },
      { binding: "block class declaration", guard: `{ class NDEBUG {} ${GATED_GUARD} }` },
      { binding: "enum", guard: `{ enum NDEBUG {} ${GATED_GUARD} }` },
      { binding: "namespace", guard: `{ namespace NDEBUG {} ${GATED_GUARD} }` },
      {
        binding: "case block const",
        guard: `switch (storage) { case 0: const NDEBUG = true; ${GATED_GUARD} }`,
      },
      {
        binding: "for initializer let",
        guard: `for (let NDEBUG = true; NDEBUG; NDEBUG = false) ${GATED_GUARD}`,
      },
      { binding: "for-in const", guard: `for (const NDEBUG in {}) ${GATED_GUARD}` },
      { binding: "arrow parameter", guard: `void ((NDEBUG: boolean) => { ${GATED_GUARD} });` },
    ])("names the guard whose gate reads a $binding", async ({ declarations = "", guard }) => {
      const problems = await gatingProblems({
        [REJECTED_MODULE]: guardedModule(declarations, guard),
      });

      expect(problems).toStrictEqual([SHADOWED]);
    });
  });

  describe("when a guard can run without the runtime's DEBUG initializer", () => {
    it.each([
      {
        name: "a guard with no gate",
        outputs: { [REJECTED_MODULE]: guardedModule("", BARE_GUARD) },
        expected: [`${REJECTED_MODULE}:4: the shape guard runs without a DEBUG gate`],
      },
      {
        name: "a guard gated by another identifier",
        outputs: {
          [REJECTED_MODULE]: guardedModule("const enabled = true;", `enabled && ${BARE_GUARD}`),
        },
        expected: [gatedOtherwise("enabled")],
      },
      {
        name: "a guard gated by a top-level DEBUG holding the runtime's initializer",
        outputs: {
          [REJECTED_MODULE]: guardedModule(
            `const DEBUG = ${CHECKER_GATE};`,
            `DEBUG && ${BARE_GUARD}`,
          ),
        },
        expected: [gatedOtherwise("DEBUG")],
      },
      {
        name: "a guard gated by the runtime's initializer or another operand",
        outputs: {
          [REJECTED_MODULE]: guardedModule(
            "const enabled = true;",
            `(${CHECKER_GATE} || enabled) && ${BARE_GUARD}`,
          ),
        },
        expected: [gatedOtherwise(`${CHECKER_GATE} || enabled`)],
      },
      {
        name: "a guard gated with another unary operator",
        outputs: {
          [REJECTED_MODULE]: guardedModule(
            "",
            `(typeof NDEBUG === "undefined" || -NDEBUG) && ${BARE_GUARD}`,
          ),
        },
        expected: [gatedOtherwise('typeof NDEBUG === "undefined" || -NDEBUG')],
      },
      {
        name: "a guard gated by negating another identifier",
        outputs: {
          [REJECTED_MODULE]: guardedModule(
            "",
            `(typeof NDEBUG === "undefined" || !OTHER) && ${BARE_GUARD}`,
          ),
        },
        expected: [gatedOtherwise('typeof NDEBUG === "undefined" || !OTHER')],
      },
      {
        name: "a guard through a named import with no gate",
        outputs: {
          [REJECTED_MODULE]: `import { assertShape } from "ecstatic/internal";\nassertShape(storage, "${SHAPE_KEY}");\n`,
        },
        expected: [`${REJECTED_MODULE}:2: the shape guard runs without a DEBUG gate`],
      },
      {
        name: "a guard through an aliased named import with no gate",
        outputs: {
          [REJECTED_MODULE]: `import { assertShape as check } from "ecstatic/internal";\ncheck(storage, "${SHAPE_KEY}");\n`,
        },
        expected: [`${REJECTED_MODULE}:2: the shape guard runs without a DEBUG gate`],
      },
    ])("names $name", async ({ outputs, expected }) => {
      const problems = await gatingProblems(outputs);

      expect(problems).toStrictEqual(expected);
    });

    it("names a gate whose call passes fewer arguments than the runtime's", async () => {
      const callRuntime = runtimeDebug(
        await session.parseText(
          projectPath(REPO_ROOT, "tests/integration/call-debug.ts"),
          "export const DEBUG = enabled(NDEBUG, true);\n",
        ),
      );
      const files = await parsed({
        [GATED_MODULE]: guardedModule("", `enabled(NDEBUG, true) && ${FILTER_LIST};`),
        [REJECTED_MODULE]: guardedModule("", `enabled(NDEBUG) && ${BARE_GUARD}`),
      });

      const problems = unstrippedProblems(files, callRuntime);

      expect(problems).toStrictEqual([gatedOtherwise("enabled(NDEBUG)")]);
    });
  });

  describe("when no test module holds a shape guard", () => {
    it.each([
      {
        name: "no guard in any output",
        outputs: { [REJECTED_MODULE]: guardedModule("", "void storage;") },
      },
      {
        name: "only a direct call of the runtime's assertShape",
        outputs: {
          [REJECTED_MODULE]: `import { assertShape } from "../../src/ecstatic/shape-guard.js";\nassertShape(storage, "${SHAPE_KEY}");\n`,
        },
      },
      {
        name: "guards only under src/",
        outputs: { "src/each.ts": guardedModule("", GATED_GUARD) },
      },
      {
        name: "a call through a type-only namespace import",
        outputs: {
          [REJECTED_MODULE]: `import type * as ecstatic_internal from "ecstatic/internal";\n${BARE_GUARD}\n`,
        },
      },
      {
        name: "a call through a type-only named import",
        outputs: {
          [REJECTED_MODULE]: `import { type assertShape } from "ecstatic/internal";\nassertShape(storage, "${SHAPE_KEY}");\n`,
        },
      },
      {
        name: "a call beside a side-effect import",
        outputs: {
          [REJECTED_MODULE]: `import "ecstatic/internal";\nassertShape(storage, "${SHAPE_KEY}");\n`,
        },
      },
    ])("reports it has nothing to check for $name", async ({ outputs }) => {
      const problems = await gatingProblems(outputs);

      expect(problems).toStrictEqual([NO_SHAPE_GUARDS]);
    });
  });

  describe("when no test module holds a filter-element guard", () => {
    it("reports it has nothing to check", async () => {
      const problems = await checkerProblems({ [REJECTED_MODULE]: guardedModule("", GATED_GUARD) });

      expect(problems).toStrictEqual([NO_FILTER_GUARDS]);
    });
  });
});

describe("runtimeDebug", () => {
  it.each([
    { name: "no DEBUG", text: "export const NDEBUG = false;\n" },
    { name: "a let DEBUG", text: "export let DEBUG = true;\n" },
    { name: "a DEBUG with no initializer", text: "export declare const DEBUG: boolean;\n" },
  ])("rejects a debug module declaring $name, naming the file", async ({ text }) => {
    const file = projectPath(REPO_ROOT, "tests/integration/bad-debug.ts");
    const debug = await session.parseText(file, text);

    const read = (): Expression => runtimeDebug(debug);

    expect(read).toThrow(
      new Error(`${debug.fileName} declares no top-level const DEBUG with an initializer`),
    );
  });
});
