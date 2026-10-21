import { SourceMap } from "node:module";

import { getTouchingPropertyName, type SourceFile } from "typescript/ast";
import { afterAll, beforeAll, describe, expect, it, onTestFinished } from "vitest";

import { analyze } from "../../../src/plugin/optimizer/analysis/analyze.js";
import {
  type Checker,
  resolveSymbol,
  sourceFileName,
  type Type,
  typeOfSymbol,
  typeSymbol,
} from "../../../src/plugin/optimizer/compiler.js";
import { bailDiagnostics } from "../../../src/plugin/optimizer/diagnostics.js";
import type { EmitFile } from "../../../src/plugin/optimizer/emit/emit.js";
import type { Position, ViewUse } from "../../../src/plugin/optimizer/facts.js";
import type { Bail, EachInlining } from "../../../src/plugin/optimizer/plan.js";
import {
  createRewriter,
  type Rewriter,
  type RewriteSeams,
  type RewrittenModule,
} from "../../../src/plugin/optimizer/rewrite.js";
import {
  type ProjectView,
  type Session,
  SessionEndedError,
} from "../../../src/plugin/optimizer/session.js";
import { locate } from "./locate.js";
import {
  ASYNC_CALL,
  callPosition,
  COMPONENTS_FILE,
  DEBUG_FILE,
  HEALTH_FILE,
  MAIN_FILE,
  MAIN_SOURCE,
  mainProject,
  MOVERS_CALL,
  STATUES_CALL,
} from "./main-project.js";
import { declarationCounts, NAMESPACE_IMPORT, ROW_LOOP } from "./printed.js";
import { processesStartedSince, runningProcesses, waitUntilDead } from "./processes.js";
import {
  closeProject,
  killCompiler,
  type OpenProject,
  openProject,
  projectPath,
  runtimeCopy,
  runtimeProject,
  SPAWN_TIMEOUT_MS,
} from "./project.js";

/** The second ecstatic package root of the project, beside the project's own. */
const VENDOR_ROOT = "vendor/ecstatic";

/** An ecstatic package root whose runtime has no `src/ecstatic/debug.ts`. */
const BROKEN_ROOT = "vendor/broken";

/** Ends the `src/ecstatic/debug.ts` of {@link VENDOR_ROOT}, so its text differs from the project's own. */
const VENDOR_DEBUG_MARK = "// The vendored copy.\n";

/** Imports and declares a storage over the project's runtime and one over {@link VENDOR_ROOT}'s. */
const TWO_ROOTS_PRELUDE = `import { archetype, component, each, type Storage } from "../src/ecstatic/index.js";
import {
    archetype as vendorArchetype,
    component as vendorComponent,
    each as vendorEach,
    type Storage as VendorStorage,
} from "../vendor/ecstatic/src/ecstatic/index.js";

const Spot = component("Spot", { x: 0 });
const Marker = archetype([Spot]);
declare const markers: Storage<typeof Marker>;
const Pin = vendorComponent("Pin", { y: 0 });
const Flag = vendorArchetype([Pin]);
declare const flags: VendorStorage<typeof Flag>;

`;

const MARKERS_EACH = "each(markers, (e) => {\n    e.Spot.x += 1;\n});\n";
const FLAGS_EACH = "vendorEach(flags, (e) => {\n    e.Pin.y += 1;\n});\n";
const MARKERS_CALL = "each(markers";
const FLAGS_CALL = "vendorEach(flags";

/** An ecstatic package root whose `src/ecstatic/debug.ts` declares `DEBUG` with no initializer. */
const GATELESS_ROOT = "vendor/gateless";

/** Two eligible `each` calls over the runtime under `runtimeRoot`. */
function twoCallsOver(runtimeRoot: string): string {
  return `import { archetype, component, each, type Storage } from "../${runtimeRoot}/src/ecstatic/index.js";

const Spot = component("Spot", { x: 0 });
const Pin = component("Pin", { y: 0 });
const Marker = archetype([Spot]);
const Flag = archetype([Pin]);
declare const markers: Storage<typeof Marker>;
declare const flags: Storage<typeof Flag>;

each(markers, (e) => {
    e.Spot.x += 1;
});
each(flags, (e) => {
    e.Pin.y += 1;
});
`;
}

/** An eligible `each` call, then one whose callback holds an eligible nested call. */
const NESTED_SOURCE = `import { archetype, component, each, type Storage } from "../src/ecstatic/index.js";

const Spot = component("Spot", { x: 0 });
const Pin = component("Pin", { y: 0 });
const Marker = archetype([Spot]);
const Flag = archetype([Pin]);
declare const markers: Storage<typeof Marker>;
declare const flags: Storage<typeof Flag>;

each(markers, (e) => {
    e.Spot.x += 1;
});
each(markers, () => {
    each(flags, (f) => {
        f.Pin.y += 1;
    });
});
`;

/** The nested call of {@link NESTED_SOURCE}. */
const NESTED_CALL = "each(flags";

/** An eligible call over the project's runtime, then one whose nested call is over the vendored runtime. */
const NESTED_VENDOR_SOURCE = `${TWO_ROOTS_PRELUDE}${MARKERS_EACH}each(markers, () => {
    vendorEach(flags, (f) => {
        f.Pin.y += 1;
    });
});
`;

/** A bailing `each` call past a character outside the Basic Multilingual Plane on its line. */
const ASTRAL_SOURCE = `import { archetype, each, type Storage } from "../src/ecstatic/index.js";
import { Position, Velocity } from "./components.js";

const Mover = archetype([Position, Velocity]);
declare const movers: Storage<typeof Mover>;

const fruit = "🍌"; each(movers, async (e) => {
    e.Position.x = fruit.length;
});
`;

/** One `each` call, which the async callback bails. */
const BAILING_SOURCE = `import { archetype, each, type Storage } from "../src/ecstatic/index.js";
import { Position, Velocity } from "./components.js";

const Mover = archetype([Position, Velocity]);
declare const movers: Storage<typeof Mover>;

each(movers, async (e) => {
    e.Position.x = 1;
});
`;

/**
 * Binds, beside an inlined `each` call, every name a generated name of the loop could take: as
 * variables, an ambient declaration, an import alias, and parameters.
 */
const NAMES_SOURCE = `import { archetype, component, each, type Storage } from "../src/ecstatic/index.js";
import { Position, Velocity as VelocityRecord } from "./components.js";

const Cell = component("Grid,Cell", { n: 0 });
const Mover = archetype([Position, Cell], [VelocityRecord]);
declare const movers: Storage<typeof Mover>;
declare const mask: number;
const ecstatic_internal = 1;
const DEBUG = 2;
let shapeKey = 3;
var storage = 4;
const n = 5;
const i = 6;
const entities = 7;
const PositionRecord = 8;
const record = 9;
const steps = 2;

export function tick(xColumn: number, row: number): void {
    each(movers, (e) => {
        for (let step = 0; step < steps; step++) {
            if (step > row) return;
        }
        if (e.Velocity !== undefined) e.Position.x += e.Velocity.dx;
        e["Grid,Cell"].n += record;
        e.Position.x += ecstatic_internal + DEBUG + shapeKey + storage + n + i + entities + mask + PositionRecord + xColumn + e.id;
    });
}
`;

const OWN_FIRST_FILE = "app/own-first.ts";
const VENDORED_FIRST_FILE = "app/vendored-first.ts";
const BROKEN_FILE = "app/broken.ts";
const GATELESS_FILE = "app/gateless.ts";
const NESTED_FILE = "app/nested.ts";
const NESTED_VENDOR_FILE = "app/nested-vendor.ts";
const ASTRAL_FILE = "app/astral.ts";
const BAILING_FILE = "app/bailing.ts";
const NAMES_FILE = "app/names.ts";

/** What the throwing seams throw. */
const THROWN = "banana split";

/** The main project, plus the case files and the two runtime copies they import. */
function projectFiles(): Record<string, string> {
  const runtime = runtimeProject();
  const vendor = runtimeCopy(runtime, VENDOR_ROOT);
  vendor[`${VENDOR_ROOT}/${DEBUG_FILE}`] += VENDOR_DEBUG_MARK;
  const broken = runtimeCopy(runtime, BROKEN_ROOT);
  delete broken[`${BROKEN_ROOT}/${DEBUG_FILE}`];
  const gateless = runtimeCopy(runtime, GATELESS_ROOT);
  gateless[`${GATELESS_ROOT}/${DEBUG_FILE}`] = "export declare const DEBUG: boolean;\n";
  return mainProject({
    ...vendor,
    ...broken,
    ...gateless,
    [OWN_FIRST_FILE]: TWO_ROOTS_PRELUDE + MARKERS_EACH + FLAGS_EACH,
    [VENDORED_FIRST_FILE]: TWO_ROOTS_PRELUDE + FLAGS_EACH + MARKERS_EACH,
    [BROKEN_FILE]: twoCallsOver(BROKEN_ROOT),
    [GATELESS_FILE]: twoCallsOver(GATELESS_ROOT),
    [NESTED_FILE]: NESTED_SOURCE,
    [NESTED_VENDOR_FILE]: NESTED_VENDOR_SOURCE,
    [ASTRAL_FILE]: ASTRAL_SOURCE,
    [BAILING_FILE]: BAILING_SOURCE,
    [NAMES_FILE]: NAMES_SOURCE,
  });
}

let root: string;
let session: Session;
let view: ProjectView;
let files: Record<string, string>;

beforeAll(async () => {
  files = projectFiles();
  ({ root, session, view } = await openProject(files));
}, SPAWN_TIMEOUT_MS);

afterAll(() => closeProject(session));

/** The slash-separated `rel` as an absolute path in the project. */
function path(rel: string): string {
  return projectPath(root, rel);
}

/** Rewrites the project file at `rel` with a rewriter over `seams`. */
function rewriteFile(rel: string, seams?: RewriteSeams): Promise<RewrittenModule> {
  return createRewriter(session, seams).rewrite(view, path(rel));
}

/** The text of the output of `rewritten`, empty when the module is left unchanged. */
function outputText(rewritten: RewrittenModule): string {
  return rewritten.output?.text ?? "";
}

/** The reason, position, and detail of each `each` bail of `bails`, in order; the other ops bail silently. */
function eachBails(bails: readonly Bail[]) {
  return bails
    .filter(({ op }) => op === "each")
    .map(({ reason, pos, detail }) => ({ reason, pos, detail }));
}

/** The op, reason, position, and detail of each bail of `bails`, in order. */
function bailsOf(bails: readonly Bail[]) {
  return bails.map(({ op, reason, pos, detail }) => ({ op, reason, pos, detail }));
}

/** The `INTERNAL` bails of `bails`, in order. */
function internalBails(bails: readonly Bail[]) {
  return eachBails(bails).filter(({ reason }) => reason === "INTERNAL");
}

/** The calls of `calls` that `text` still holds, in order. */
function keptCalls(text: string, calls: readonly string[]): string[] {
  return calls.filter((call) => text.includes(call));
}

/** How many times `token` occurs in `text`. */
function occurrences(text: string, token: string): number {
  return text.split(token).length - 1;
}

/** The index in `text` of the occurrence of `token` that `nth` other occurrences precede. */
function nthIndex(text: string, token: string, nth: number): number {
  let index = text.indexOf(token);
  for (let seen = 0; seen < nth && index !== -1; seen++) index = text.indexOf(token, index + 1);
  return index;
}

/** Every identifier-shaped word of `text`. */
function words(text: string): Set<string> {
  return new Set(text.match(/[A-Za-z_$][\w$]*/gu) ?? []);
}

/** The names `after` declares more often than `before` does, sorted. */
function addedDeclarations(before: string, after: string): string[] {
  const counts = declarationCounts(before);
  return [...declarationCounts(after)]
    .filter(([name, count]) => count > (counts.get(name) ?? 0))
    .map(([name]) => name)
    .toSorted();
}

/** The 0-based line and UTF-16 column of `index` in `text`. */
function positionIn(text: string, index: number): { line: number; column: number } {
  const before = text.slice(0, index);
  const line = before.split("\n").length - 1;
  return { line, column: index - (before.lastIndexOf("\n") + 1) };
}

/** Emits each inlining as the rewriter does, except that emitting the one at `target` throws. */
function throwingEmitAt(target: Position): RewriteSeams {
  return {
    inline: (file: EmitFile, inlining: EachInlining, uses: readonly ViewUse[]) => {
      if (inlining.pos.offset === target.offset) throw new Error(THROWN);
      file.inline(inlining, uses);
    },
  };
}

/**
 * Analyzes as the rewriter does, except that the site of the call at `target` holds its shape
 * twice, which planning the site throws on: an eligible `each` site holds exactly one shape.
 *
 * @param target - Position of the call whose site holds its shape twice.
 * @returns Seams whose `analyze` doubles the shapes of that site.
 */
function twoShapesAt(target: Position): RewriteSeams {
  return {
    analyze: async (checker, source, roots) => {
      const analysis = await analyze(checker, source, roots);
      const sites = analysis.sites.map((site) =>
        site.pos.offset === target.offset
          ? { ...site, shapes: [...site.shapes, ...site.shapes] }
          : site,
      );
      return { ...analysis, sites };
    },
  };
}

/** The type of the value declared as `const name` in `source`, as `checker` sees it. */
async function typeOfDeclared(checker: Checker, source: SourceFile, name: string): Promise<Type> {
  const identifier = getTouchingPropertyName(source, source.text.indexOf(`const ${name}`) + 6);
  const symbol = await resolveSymbol(checker, identifier);
  if (symbol === undefined) throw new Error(`${name} resolves to no symbol`);
  return typeOfSymbol(checker, symbol);
}

interface OwnProject extends OpenProject {
  readonly pid: number;
}

/** Opens a session of its own on the main project and returns it with its compiler's process ID. */
async function openOwnProject(): Promise<OwnProject> {
  const before = await runningProcesses();
  const own = await openProject(mainProject());
  const started = await processesStartedSince(before);
  const [pid] = started;
  if (started.length !== 1 || pid === undefined) {
    throw new Error(`expected one new compiler process, found ${started.length}`);
  }
  return { ...own, pid };
}

/** Rewrites the main file on `own`, running `during` inside the analysis before the real analysis. */
function rewriteDuringAnalysis(
  own: OwnProject,
  during: (checker: Checker, source: SourceFile) => Promise<void>,
): Promise<RewrittenModule> {
  const seams: RewriteSeams = {
    analyze: async (checker, source, roots) => {
      await during(checker, source);
      return analyze(checker, source, roots);
    },
  };
  return createRewriter(own.session, seams).rewrite(own.view, projectPath(own.root, MAIN_FILE));
}

describe("createRewriter", () => {
  describe("rewrite", () => {
    describe("when the module has eligible sites", () => {
      it("turns each eligible call into its own loop and keeps the bailing one", async () => {
        const rewritten = await rewriteFile(MAIN_FILE);

        const text = outputText(rewritten);
        expect(text).toMatch(NAMESPACE_IMPORT);
        expect(occurrences(text, ROW_LOOP)).toBe(2);
        expect(keptCalls(text, [MOVERS_CALL, STATUES_CALL, ASYNC_CALL])).toStrictEqual([
          ASYNC_CALL,
        ]);
        expect(bailsOf(rewritten.bails)).toStrictEqual([
          {
            op: "archetype",
            reason: "NOT_STATEMENT",
            pos: callPosition(root, "archetype([Position, Velocity])"),
            detail: undefined,
          },
          {
            op: "archetype",
            reason: "NOT_STATEMENT",
            pos: callPosition(root, "archetype([Position, Health])"),
            detail: undefined,
          },
          {
            op: "each",
            reason: "CALLBACK_ASYNC",
            pos: callPosition(root, ASYNC_CALL),
            detail: undefined,
          },
        ]);
        expect(rewritten.fileBail).toBeUndefined();
      });

      it.each([
        { name: "the first row loop to its call", token: ROW_LOOP, nth: 0, original: MOVERS_CALL },
        {
          name: "the second row loop to its call",
          token: ROW_LOOP,
          nth: 1,
          original: STATUES_CALL,
        },
        {
          name: "a moved body statement to its call",
          token: "hpColumn[",
          nth: 0,
          original: STATUES_CALL,
        },
        {
          name: "a kept call to its own position",
          token: ASYNC_CALL,
          nth: 0,
          original: ASYNC_CALL,
        },
      ])("maps $name", async ({ token, nth, original }) => {
        const expected = callPosition(root, original);

        const rewritten = await rewriteFile(MAIN_FILE);

        const text = outputText(rewritten);
        const map = rewritten.output?.map;
        const { line, column } = positionIn(text, nthIndex(text, token, nth));
        expect(map?.sourcesContent).toStrictEqual([MAIN_SOURCE]);
        expect(
          map === undefined ? undefined : new SourceMap(map).findEntry(line, column),
        ).toMatchObject({
          originalLine: expected.line - 1,
          originalColumn: expected.column - 1,
        });
      });

      it("lists the declaration files its sites consulted and the DEBUG copy's source", async () => {
        const rewritten = await rewriteFile(MAIN_FILE);

        expect(rewritten.consulted).toStrictEqual(
          [
            COMPONENTS_FILE,
            HEALTH_FILE,
            "src/ecstatic/archetype.ts",
            "src/ecstatic/component.ts",
            DEBUG_FILE,
            "src/ecstatic/world.ts",
          ]
            .map(path)
            .toSorted(),
        );
      });
    });

    describe("when the module has no eligible site", () => {
      it("leaves it unchanged and lists its bails and the declaration files its sites consulted", async () => {
        const at = (call: string) => locate(path(BAILING_FILE), BAILING_SOURCE, call);

        const rewritten = await rewriteFile(BAILING_FILE);

        expect(rewritten.output).toBeUndefined();
        expect(bailsOf(rewritten.bails)).toStrictEqual([
          { op: "archetype", reason: "NOT_STATEMENT", pos: at("archetype("), detail: undefined },
          { op: "each", reason: "CALLBACK_ASYNC", pos: at("each(movers"), detail: undefined },
        ]);
        expect(rewritten.consulted).toStrictEqual(
          [
            COMPONENTS_FILE,
            "src/ecstatic/archetype.ts",
            "src/ecstatic/component.ts",
            "src/ecstatic/world.ts",
          ]
            .map(path)
            .toSorted(),
        );
      });
    });

    describe("when one site fails", () => {
      it.each([
        { name: "emitting", seams: throwingEmitAt, detail: THROWN },
        { name: "planning", seams: twoShapesAt, detail: expect.stringMatching(/shapes/u) },
      ])(
        "keeps its call when $name it throws and rewrites the other sites",
        async ({ seams, detail }) => {
          const target = callPosition(root, MOVERS_CALL);

          const rewritten = await rewriteFile(MAIN_FILE, seams(target));

          const text = outputText(rewritten);
          expect(occurrences(text, ROW_LOOP)).toBe(1);
          expect(keptCalls(text, [MOVERS_CALL, STATUES_CALL, ASYNC_CALL])).toStrictEqual([
            MOVERS_CALL,
            ASYNC_CALL,
          ]);
          expect(internalBails(rewritten.bails)).toStrictEqual([
            { reason: "INTERNAL", pos: target, detail },
          ]);
        },
      );

      it("keeps a nested call when emitting it throws and rewrites the other sites", async () => {
        const target = locate(path(NESTED_FILE), NESTED_SOURCE, NESTED_CALL);

        const rewritten = await rewriteFile(NESTED_FILE, throwingEmitAt(target));

        const text = outputText(rewritten);
        expect(occurrences(text, ROW_LOOP)).toBe(1);
        expect(text).toContain(NESTED_CALL);
        expect(internalBails(rewritten.bails)).toStrictEqual([
          { reason: "INTERNAL", pos: target, detail: THROWN },
        ]);
      });
    });

    describe("when emitting every site throws", () => {
      it("leaves the module unchanged and reports INTERNAL at each would-be rewrite", async () => {
        const seams: RewriteSeams = {
          inline: () => {
            throw new Error(THROWN);
          },
        };

        const rewritten = await rewriteFile(MAIN_FILE, seams);

        expect(rewritten.output).toBeUndefined();
        expect(internalBails(rewritten.bails)).toStrictEqual([
          { reason: "INTERNAL", pos: callPosition(root, MOVERS_CALL), detail: THROWN },
          { reason: "INTERNAL", pos: callPosition(root, STATUES_CALL), detail: THROWN },
        ]);
        expect(rewritten.consulted).not.toContain(path(DEBUG_FILE));
      });
    });

    describe("when a site resolves to another package root than the file's first rewrite", () => {
      it.each([
        {
          name: "the project's call first",
          rel: OWN_FIRST_FILE,
          rewritten: MARKERS_CALL,
          kept: FLAGS_CALL,
          copied: "",
          other: VENDOR_ROOT,
        },
        {
          name: "the vendored call first",
          rel: VENDORED_FIRST_FILE,
          rewritten: FLAGS_CALL,
          kept: MARKERS_CALL,
          copied: VENDOR_ROOT,
          other: "",
        },
      ])(
        "keeps that call and rewrites the first, with $name",
        async ({ rel, rewritten: inlinedCall, kept, copied, other }) => {
          const copiedRoot = copied === "" ? root : path(copied);
          const otherRoot = other === "" ? root : path(other);
          const copiedDebug = projectPath(copiedRoot, DEBUG_FILE);
          const otherDebug = projectPath(otherRoot, DEBUG_FILE);
          const source = files[rel] ?? "";

          const rewritten = await rewriteFile(rel);

          const text = outputText(rewritten);
          expect(text).toContain(ROW_LOOP);
          expect(keptCalls(text, [inlinedCall, kept])).toStrictEqual([kept]);
          expect(eachBails(rewritten.bails)).toStrictEqual([
            {
              reason: "INTERNAL",
              pos: locate(path(rel), source, kept),
              detail: `the call resolves to the ecstatic package root ${otherRoot}, not ${copiedRoot}, which the file's DEBUG copy comes from`,
            },
          ]);
          expect(
            [copiedDebug, otherDebug].filter((file) => rewritten.consulted.includes(file)),
          ).toStrictEqual([copiedDebug]);
        },
      );

      it("keeps a nested call of the other root and rewrites the first", async () => {
        const vendorRoot = path(VENDOR_ROOT);

        const rewritten = await rewriteFile(NESTED_VENDOR_FILE);

        const text = outputText(rewritten);
        expect(occurrences(text, ROW_LOOP)).toBe(1);
        expect(text).toContain(FLAGS_CALL);
        expect(internalBails(rewritten.bails)).toStrictEqual([
          {
            reason: "INTERNAL",
            pos: locate(path(NESTED_VENDOR_FILE), NESTED_VENDOR_SOURCE, FLAGS_CALL),
            detail: `the call resolves to the ecstatic package root ${vendorRoot}, not ${root}, which the file's DEBUG copy comes from`,
          },
        ]);
      });
    });

    describe("when analyzing the file throws", () => {
      const seams: RewriteSeams = {
        analyze: async (checker, source, roots) => {
          if (sourceFileName(source) === path(MAIN_FILE)) throw new Error(THROWN);
          return analyze(checker, source, roots);
        },
      };

      it("leaves it unchanged and reports one file-level INTERNAL at the file's start", async () => {
        const rewritten = await rewriteFile(MAIN_FILE, seams);

        expect(rewritten).toStrictEqual({
          output: undefined,
          bails: [],
          fileBail: {
            reason: "INTERNAL",
            pos: { file: path(MAIN_FILE), offset: 0, line: 1, column: 1 },
            detail: THROWN,
          },
          consulted: [],
        });
      });

      it("hands the file-level INTERNAL to bailDiagnostics as a warning naming only the file", async () => {
        const rewritten = await rewriteFile(MAIN_FILE, seams);

        const diagnostics = bailDiagnostics(
          rewritten.fileBail === undefined ? [] : [rewritten.fileBail],
          false,
        );

        expect(diagnostics).toStrictEqual([
          {
            file: path(MAIN_FILE),
            category: "warning",
            code: 99_920,
            start: 0,
            line: 1,
            column: 1,
            message:
              `ecstatic: ${path(MAIN_FILE)} could not be analyzed (internal error (\`${THROWN}\`); ` +
              "please report it). Its calls compile to the runtime calls.",
          },
        ]);
      });
    });

    describe("when the session ends while analyzing the file", () => {
      const endings = [
        {
          name: "closes",
          error: expect.objectContaining({ message: expect.stringMatching(/closed/u) }),
          end: (own: OwnProject) => own.session.close(),
        },
        {
          name: "loses its compiler process",
          error: expect.objectContaining({
            message: expect.stringMatching(/exited/u),
            cause: expect.any(Error),
          }),
          end: async (own: OwnProject) => {
            process.kill(own.pid, "SIGKILL");
            await waitUntilDead(own.pid);
          },
        },
      ];

      it.each(endings)(
        "rejects naming the session when it $name before a checker query",
        async ({ error, end }) => {
          const own = await openOwnProject();
          onTestFinished(() => own.session.close());

          const rewriting = rewriteDuringAnalysis(own, () => end(own));

          await expect(rewriting).rejects.toBeInstanceOf(SessionEndedError);
          await expect(rewriting).rejects.toMatchObject(error);
          await expect(rewriting).rejects.toThrow(own.session.tsconfig);
        },
        SPAWN_TIMEOUT_MS,
      );

      it.each(endings)(
        "rejects naming the session when it $name before a query on a type the checker returned",
        async ({ error, end }) => {
          const own = await openOwnProject();
          onTestFinished(() => own.session.close());
          const failures: unknown[] = [];

          const rewriting = rewriteDuringAnalysis(own, async (checker, source) => {
            const type = await typeOfDeclared(checker, source, "movers");
            await end(own);
            try {
              await typeSymbol(type);
            } catch (failure) {
              failures.push(failure);
              throw failure;
            }
          });

          await expect(rewriting).rejects.toBeInstanceOf(SessionEndedError);
          await expect(rewriting).rejects.toMatchObject(error);
          await expect(rewriting).rejects.toThrow(own.session.tsconfig);
          expect(failures).toStrictEqual([expect.any(Error)]);
          expect(failures[0]).not.toBeInstanceOf(SessionEndedError);
        },
        SPAWN_TIMEOUT_MS,
      );

      it.each([
        {
          name: "closes",
          error: (): object =>
            expect.objectContaining({ message: expect.stringMatching(/closed/u) }),
          end: (own: OwnProject) => own.session.close(),
        },
        {
          name: "loses its compiler process",
          error: (thrown: Error): object =>
            expect.objectContaining({
              message: expect.stringMatching(/exited/u),
              cause: thrown,
            }),
          end: async (own: OwnProject) => {
            await killCompiler(own.session, own.pid);
          },
        },
      ])(
        "rejects naming the session when it $name and analysis then fails for another reason",
        async ({ error, end }) => {
          const own = await openOwnProject();
          onTestFinished(() => own.session.close());
          const thrown = new Error("banana split");

          const rewriting = rewriteDuringAnalysis(own, async () => {
            await end(own);
            throw thrown;
          });

          await expect(rewriting).rejects.toBeInstanceOf(SessionEndedError);
          await expect(rewriting).rejects.toMatchObject(error(thrown));
          await expect(rewriting).rejects.toThrow(own.session.tsconfig);
        },
        SPAWN_TIMEOUT_MS,
      );
    });

    describe("when the DEBUG copy cannot be taken", () => {
      it.each([
        { name: "is missing", rel: BROKEN_FILE, runtimeRoot: BROKEN_ROOT },
        {
          name: "declares DEBUG with no initializer",
          rel: GATELESS_FILE,
          runtimeRoot: GATELESS_ROOT,
        },
      ])(
        "keeps every call and reports INTERNAL at each would-be rewrite when it $name",
        async ({ rel, runtimeRoot }) => {
          const detail = expect.stringContaining(projectPath(path(runtimeRoot), DEBUG_FILE));
          const source = files[rel] ?? "";

          const rewritten = await rewriteFile(rel);

          expect(rewritten.output).toBeUndefined();
          expect(eachBails(rewritten.bails)).toStrictEqual([
            { reason: "INTERNAL", pos: locate(path(rel), source, "each(markers"), detail },
            { reason: "INTERNAL", pos: locate(path(rel), source, "each(flags"), detail },
          ]);
        },
      );
    });

    it("reports a bail's column in UTF-16 code units past a character outside the BMP", async () => {
      const rewritten = await rewriteFile(ASTRAL_FILE);

      const diagnostics = bailDiagnostics(rewritten.bails, true);

      expect(diagnostics.map(({ line, column }) => ({ line, column }))).toStrictEqual([
        { line: 7, column: 21 },
      ]);
    });

    it.each([
      { name: "a new rewriter", second: () => createRewriter(session) },
      { name: "the same rewriter", second: (first: Rewriter) => first },
    ])("gives identical output when $name rewrites the same module again", async ({ second }) => {
      const rewriter = createRewriter(session);
      const first = await rewriter.rewrite(view, path(MAIN_FILE));

      const again = await second(rewriter).rewrite(view, path(MAIN_FILE));

      expect(again).toStrictEqual(first);
    });

    it("declares every generated name apart from every name of the module", async () => {
      const rewritten = await rewriteFile(NAMES_FILE);

      const generated = addedDeclarations(NAMES_SOURCE, outputText(rewritten));

      expect(generated.filter((name) => words(NAMES_SOURCE).has(name))).toStrictEqual([]);
      expect(generated).toStrictEqual(
        expect.arrayContaining([
          "DEBUG_1",
          "PositionRecord_1",
          "VelocityRecord_1",
          "dxColumn",
          "ecstatic_internal_1",
          "entities_1",
          "i_1",
          "mask_1",
          "n_1",
          "record_1",
          "row_1",
          "shapeKey_1",
          "storage_1",
          "xColumn_1",
        ]),
      );
    });
  });
});
