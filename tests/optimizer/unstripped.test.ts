import { join, relative, resolve, sep } from "node:path";

import type { Expression, SourceFile } from "typescript/ast";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createRewriter, type Rewriter } from "../../src/plugin/optimizer/rewrite.js";
import { openSession, type ProjectView, type Session } from "../../src/plugin/optimizer/session.js";
import {
  closeProject,
  openProject,
  projectPath,
  runtimeProject,
  SPAWN_TIMEOUT_MS,
} from "../unit/optimizer/project.js";
import { NO_GUARDS, runtimeDebug, unstrippedProblems } from "./unstripped.js";

const ROOT = resolve(import.meta.dirname, "../..");

/** The project the optimized unit projects hand `ecstatic/vite`. */
const TESTS_TSCONFIG = join(ROOT, "tests", "tsconfig.json");

/** How long rewriting every module the optimized unit projects run may take on a slow CI runner. */
const REWRITE_TIMEOUT_MS = 60_000;

/**
 * The optimizer's corpus and tests, which no optimized unit project runs. Every other module of the
 * tests' program is checked: a superset of what those projects transform, helpers they import from
 * `scripts/` and `tests/unit/optimizer/` included.
 */
const OPTIMIZER_TESTS = "tests/optimizer/";

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

/** A module that binds `DEBUG` itself, so the emitter names its `DEBUG` copy apart. */
const FLAGS_MODULE = "app/flags.ts";

const INLINED_SOURCE = `import { archetype, component, each, type Storage } from "../src/ecstatic/index.js";

const Position = component("Position", { x: 0, y: 0 });
const Mover = archetype([Position]);

export function advance(movers: Storage<typeof Mover>): void {
  each(movers, (e) => {
    e.Position.x += 1;
  });
}
`;

/** The `src/ecstatic/debug.ts` the rejecting cases compare `DEBUG` copies with. */
const CHECKER_RUNTIME = `declare const NDEBUG: boolean | undefined;
export const DEBUG = typeof NDEBUG === "undefined" || !NDEBUG;
`;

/** A `DEBUG` copy initialized as {@link CHECKER_RUNTIME} initializes `DEBUG`. */
const RUNTIME_COPY = 'const DEBUG = typeof NDEBUG === "undefined" || !NDEBUG;';

const BARE_GUARD = "ecstatic_internal.assertShape(storage, shapeKey);";

/** A shape guard gated by {@link RUNTIME_COPY}. */
const GATED_GUARD = `DEBUG && ${BARE_GUARD}`;

const NO_GUARD_BODY = "void storage;";

/** The test module the rejecting cases write their outputs as. */
const REJECTED_MODULE = "tests/unit/a.test.ts";

/** The problem named for a `DEBUG` copy initialized to `true` in {@link REJECTED_MODULE}. */
const WRONG_COPY = `${REJECTED_MODULE}: the DEBUG copy DEBUG is initialized to true, not as src/ecstatic/debug.ts initializes DEBUG`;

/** The problem named for a guard on line 5 of {@link REJECTED_MODULE} gated by a `DEBUG` that is no copy. */
const FOREIGN_GATE = `${REJECTED_MODULE}:5: the shape guard is gated by DEBUG, not by the file's DEBUG copy`;

/** The problem named for a guard on line 5 of {@link REJECTED_MODULE} gated by a shadowed copy. */
const SHADOWED = `${REJECTED_MODULE}:5: the shape guard is gated by DEBUG (a local binding), not by the file's DEBUG copy`;

let session: Session;
let rewriter: Rewriter;
let runtime: Expression;
let checkerRuntime: Expression;

beforeAll(async () => {
  session = await openSession(TESTS_TSCONFIG);
  rewriter = createRewriter(session);
  runtime = runtimeDebug(await session.parse(join(ROOT, "src", "ecstatic", "debug.ts")));
  checkerRuntime = runtimeDebug(
    await session.parseText(join(ROOT, "tests", "optimizer", "checker-debug.ts"), CHECKER_RUNTIME),
  );
}, SPAWN_TIMEOUT_MS);

afterAll(async () => {
  await session.close();
});

/** The output of a rewritten module whose preamble declares `declarations` on line 2 and whose function holds `guard` on line 5. */
function guardedModule(declarations: string, guard: string): string {
  return `import * as ecstatic_internal from "ecstatic/internal";
${declarations}
const shapeKey = "c8:Position{1:x=n,1:y=n}|";
export function run(storage: unknown): void {
  ${guard}
}
`;
}

/** The slash-separated path of `file` from the repository root. */
function repoName(file: string): string {
  return relative(ROOT, file).split(sep).join("/");
}

/** The absolute path of `name`, a slash-separated path from the repository root. */
function repoFile(name: string): string {
  return join(ROOT, ...name.split("/"));
}

/** Parses each output of `outputs`, keyed by slash-separated path from the repository root. */
async function parsed(outputs: Readonly<Record<string, string>>): Promise<Map<string, SourceFile>> {
  const entries = await Promise.all(
    Object.entries(outputs).map(
      async ([name, text]) => [name, await session.parseText(repoFile(name), text)] as const,
    ),
  );
  return new Map(entries);
}

/** The problems with `outputs`, checked against the DEBUG initializer of {@link CHECKER_RUNTIME}. */
async function checkerProblems(outputs: Readonly<Record<string, string>>): Promise<string[]> {
  return unstrippedProblems(await parsed(outputs), checkerRuntime);
}

/** The text `by` rewrites `file` to in `view`, failing when it leaves the module unchanged. */
async function rewrittenText(by: Rewriter, view: ProjectView, file: string): Promise<string> {
  const { output } = await by.rewrite(view, file);
  if (output === undefined) throw new Error(`${file} was left unchanged by the optimizer`);
  return output.text;
}

describe("unstrippedProblems", () => {
  describe("over the modules the optimized unit projects transform", () => {
    let checked: string[];
    let outputs: Map<string, SourceFile>;

    beforeAll(async () => {
      const view = await session.update();
      const files = (await view.sourceFileNames()).filter((file) => {
        const name = repoName(file);
        return !name.startsWith(OPTIMIZER_TESTS);
      });
      checked = files.map(repoName);
      const rewritten = await Promise.all(
        files.map(async (file) => {
          const { output } = await rewriter.rewrite(view, file);
          return output === undefined ? [] : [[repoName(file), output.text] as const];
        }),
      );
      outputs = await parsed(Object.fromEntries(rewritten.flat()));
    }, REWRITE_TIMEOUT_MS);

    it("checks the helpers the runtime unit tests import from outside them", () => {
      expect(checked).toStrictEqual(expect.arrayContaining(TRANSFORMED_HELPERS));
    });

    it("finds every shape guard gated by a copy of the runtime DEBUG", () => {
      const problems = unstrippedProblems(outputs, runtime);

      expect(problems).toStrictEqual([]);
    });
  });

  describe("when every guard is gated by a copy of the runtime DEBUG", () => {
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
          "src/each.ts": guardedModule(RUNTIME_COPY, BARE_GUARD),
        }),
      },
    ])("reports nothing for $name", async ({ outputs }) => {
      const files = await parsed(outputs());

      const problems = unstrippedProblems(files, runtime);

      expect(problems).toStrictEqual([]);
    });
  });

  describe("when a local binding shadows the DEBUG copy", () => {
    it.each([
      { binding: "function parameter", guard: `function f(DEBUG: boolean) { ${GATED_GUARD} }` },
      {
        binding: "destructured parameter",
        guard: `function f({ DEBUG }: { DEBUG: boolean }) { ${GATED_GUARD} }`,
      },
      { binding: "block-scoped const", guard: `{ const DEBUG = true; ${GATED_GUARD} }` },
      { binding: "hoisted var", guard: `function f() { ${GATED_GUARD} var DEBUG = true; }` },
      { binding: "catch clause", guard: `try { throw true; } catch (DEBUG) { ${GATED_GUARD} }` },
      { binding: "class name", guard: `void class DEBUG { static { ${GATED_GUARD} } };` },
      { binding: "function expression name", guard: `void function DEBUG() { ${GATED_GUARD} };` },
      { binding: "for-of const", guard: `for (const DEBUG of [true]) ${GATED_GUARD}` },
      { binding: "block-scoped let", guard: `{ let DEBUG = true; ${GATED_GUARD} }` },
      { binding: "block function declaration", guard: `{ function DEBUG() {} ${GATED_GUARD} }` },
      { binding: "block class declaration", guard: `{ class DEBUG {} ${GATED_GUARD} }` },
      { binding: "enum", guard: `{ enum DEBUG {} ${GATED_GUARD} }` },
      { binding: "namespace", guard: `{ namespace DEBUG {} ${GATED_GUARD} }` },
      {
        binding: "case block const",
        guard: `switch (storage) { case 0: const DEBUG = true; ${GATED_GUARD} }`,
      },
      {
        binding: "for initializer let",
        guard: `for (let DEBUG = true; DEBUG; DEBUG = false) ${GATED_GUARD}`,
      },
      { binding: "for-in const", guard: `for (const DEBUG in {}) ${GATED_GUARD}` },
      { binding: "arrow parameter", guard: `void ((DEBUG: boolean) => { ${GATED_GUARD} });` },
    ])("names the guard shadowed by a $binding", async ({ guard }) => {
      const problems = await checkerProblems({
        [REJECTED_MODULE]: guardedModule(RUNTIME_COPY, guard),
      });

      expect(problems).toStrictEqual([SHADOWED]);
    });
  });

  describe("when a guard can run without the DEBUG copy", () => {
    it.each([
      {
        name: "a guard with no gate",
        outputs: { [REJECTED_MODULE]: guardedModule(RUNTIME_COPY, BARE_GUARD) },
        expected: [`${REJECTED_MODULE}:5: the shape guard runs without a DEBUG gate`],
      },
      {
        name: "a guard gated by another identifier",
        outputs: {
          [REJECTED_MODULE]: guardedModule(
            `${RUNTIME_COPY} const enabled = true;`,
            `enabled && ${BARE_GUARD}`,
          ),
        },
        expected: [
          `${REJECTED_MODULE}:5: the shape guard is gated by enabled, not by the file's DEBUG copy`,
        ],
      },
      {
        name: "a guard through a named import with no gate",
        outputs: {
          [REJECTED_MODULE]:
            'import { assertShape } from "ecstatic/internal";\nassertShape(storage, shapeKey);\n',
        },
        expected: [`${REJECTED_MODULE}:2: the shape guard runs without a DEBUG gate`],
      },
      {
        name: "a guard through an aliased named import with no gate",
        outputs: {
          [REJECTED_MODULE]:
            'import { assertShape as check } from "ecstatic/internal";\ncheck(storage, shapeKey);\n',
        },
        expected: [`${REJECTED_MODULE}:2: the shape guard runs without a DEBUG gate`],
      },
      {
        name: "a guard gated by a DEBUG declared beside another name",
        outputs: {
          [REJECTED_MODULE]: guardedModule(`${RUNTIME_COPY.slice(0, -1)}, other = 1;`, GATED_GUARD),
        },
        expected: [FOREIGN_GATE],
      },
      {
        name: "a guard gated by a const whose name no DEBUG copy takes",
        outputs: {
          [REJECTED_MODULE]: guardedModule(
            RUNTIME_COPY.replace("DEBUG =", "DEBUG_0 ="),
            `DEBUG_0 && ${BARE_GUARD}`,
          ),
        },
        expected: [
          `${REJECTED_MODULE}:5: the shape guard is gated by DEBUG_0, not by the file's DEBUG copy`,
        ],
      },
      {
        name: "a guard gated by a DEBUG declared before the namespace import",
        outputs: {
          [REJECTED_MODULE]: `${RUNTIME_COPY}\nexport function run(storage: unknown): void {\n  ${GATED_GUARD}\n}\nimport * as ecstatic_internal from "ecstatic/internal";\n`,
        },
        expected: [
          `${REJECTED_MODULE}:3: the shape guard is gated by DEBUG, not by the file's DEBUG copy`,
        ],
      },
    ])("names $name", async ({ outputs, expected }) => {
      const problems = await checkerProblems(outputs);

      expect(problems).toStrictEqual(expected);
    });
  });

  describe("when the DEBUG copy is initialized otherwise", () => {
    it.each([
      {
        name: "a copy that gates a guard",
        outputs: { [REJECTED_MODULE]: guardedModule("const DEBUG = true;", GATED_GUARD) },
        expected: [WRONG_COPY],
      },
      {
        name: "a copy that gates no guard",
        outputs: {
          [REJECTED_MODULE]: guardedModule("const DEBUG = true;", NO_GUARD_BODY),
          "tests/unit/b.test.ts": guardedModule(RUNTIME_COPY, GATED_GUARD),
        },
        expected: [WRONG_COPY],
      },
      {
        name: "a copy with another unary operator",
        outputs: {
          [REJECTED_MODULE]: guardedModule(
            'const DEBUG = typeof NDEBUG === "undefined" || -NDEBUG;',
            GATED_GUARD,
          ),
        },
        expected: [
          `${REJECTED_MODULE}: the DEBUG copy DEBUG is initialized to typeof NDEBUG === "undefined" || -NDEBUG, not as src/ecstatic/debug.ts initializes DEBUG`,
        ],
      },
      {
        name: "a copy that negates another identifier",
        outputs: {
          [REJECTED_MODULE]: guardedModule(
            'const DEBUG = typeof NDEBUG === "undefined" || !OTHER;',
            GATED_GUARD,
          ),
        },
        expected: [
          `${REJECTED_MODULE}: the DEBUG copy DEBUG is initialized to typeof NDEBUG === "undefined" || !OTHER, not as src/ecstatic/debug.ts initializes DEBUG`,
        ],
      },
    ])("names $name", async ({ outputs, expected }) => {
      const problems = await checkerProblems(outputs);

      expect(problems).toStrictEqual(expected);
    });

    it("names a copy whose call passes fewer arguments than the runtime's", async () => {
      const callRuntime = runtimeDebug(
        await session.parseText(
          repoFile("tests/optimizer/call-debug.ts"),
          "export const DEBUG = enabled(NDEBUG, true);\n",
        ),
      );
      const files = await parsed({
        [REJECTED_MODULE]: guardedModule("const DEBUG = enabled(NDEBUG);", GATED_GUARD),
      });

      const problems = unstrippedProblems(files, callRuntime);

      expect(problems).toStrictEqual([
        `${REJECTED_MODULE}: the DEBUG copy DEBUG is initialized to enabled(NDEBUG), not as src/ecstatic/debug.ts initializes DEBUG`,
      ]);
    });
  });

  describe("when a parenthesized copy gates the guard", () => {
    it("reports nothing", async () => {
      const problems = await checkerProblems({
        [REJECTED_MODULE]: guardedModule(RUNTIME_COPY, `(DEBUG) && ${BARE_GUARD}`),
      });

      expect(problems).toStrictEqual([]);
    });
  });

  describe("when no test module holds a shape guard", () => {
    it.each([
      {
        name: "no guard in any output",
        outputs: { [REJECTED_MODULE]: guardedModule(RUNTIME_COPY, NO_GUARD_BODY) },
      },
      {
        name: "only a direct call of the runtime's assertShape",
        outputs: {
          [REJECTED_MODULE]:
            'import { assertShape } from "../../src/ecstatic/shape-guard.js";\nassertShape(storage, "c8:Position{1:x=n,1:y=n}|");\n',
        },
      },
      {
        name: "guards only under src/",
        outputs: { "src/each.ts": guardedModule(RUNTIME_COPY, GATED_GUARD) },
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
          [REJECTED_MODULE]:
            'import { type assertShape } from "ecstatic/internal";\nassertShape(storage, shapeKey);\n',
        },
      },
      {
        name: "a call beside a side-effect import",
        outputs: {
          [REJECTED_MODULE]: 'import "ecstatic/internal";\nassertShape(storage, shapeKey);\n',
        },
      },
    ])("reports it has nothing to check for $name", async ({ outputs }) => {
      const problems = await checkerProblems(outputs);

      expect(problems).toStrictEqual([NO_GUARDS]);
    });
  });
});

describe("runtimeDebug", () => {
  it.each([
    { name: "no DEBUG", text: "export const NDEBUG = false;\n" },
    { name: "a let DEBUG", text: "export let DEBUG = true;\n" },
    { name: "a DEBUG with no initializer", text: "export declare const DEBUG: boolean;\n" },
  ])("rejects a debug module declaring $name, naming the file", async ({ text }) => {
    const file = repoFile("tests/optimizer/bad-debug.ts");
    const debug = await session.parseText(file, text);

    const read = (): Expression => runtimeDebug(debug);

    expect(read).toThrow(
      new Error(`${debug.fileName} declares no top-level const DEBUG with an initializer`),
    );
  });
});
