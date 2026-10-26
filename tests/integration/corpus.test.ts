import { readdirSync, readFileSync, realpathSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { analyze } from "../../src/plugin/optimizer/analysis/analyze.js";
import { sourceFileName } from "../../src/plugin/optimizer/compiler.js";
import {
  type BailDiagnostic,
  bailDiagnostics,
  type FileBail,
} from "../../src/plugin/optimizer/diagnostics.js";
import { RULES, type Rule } from "../../src/plugin/optimizer/emit/catalog.js";
import type { EmitFile } from "../../src/plugin/optimizer/emit/emit.js";
import {
  compareCodeUnits,
  DETAIL_PLACEHOLDER,
  type Reason,
  REASONS,
  type ReasonInfo,
  reasonInfo,
  type Site,
} from "../../src/plugin/optimizer/facts.js";
import { type Bail, plan, type PlanResult } from "../../src/plugin/optimizer/plan.js";
import {
  createRewriter,
  type RewriteSeams,
  type RewrittenModule,
} from "../../src/plugin/optimizer/rewrite.js";
import { openSession, type Session } from "../../src/plugin/optimizer/session.js";
import { advanceCall } from "../benchmarks/fixtures.js";
import { relativePath } from "../unit/optimizer/project.js";
import { createProject, removeTempDirs } from "../unit/plugin/tsconfig-fixtures.js";
import {
  CORPUS_FILES,
  CORPUS_ROOT,
  FIXTURES,
  fixtureOf,
  fixturePath,
  GOLDEN_FILE,
  INPUT_FILE,
} from "./fixture-corpus.js";

const BENCHMARK_ROOT = realpathSync(fileURLToPath(new URL("../../benchmarks", import.meta.url)));

const REPO_ROOT = realpathSync(fileURLToPath(new URL("../..", import.meta.url)));

const UNIT_ROOT = join(REPO_ROOT, "tests", "unit");

/** Every `.ts` file of the unit suite, absolute and sorted. */
const UNIT_FILES = readdirSync(UNIT_ROOT, { recursive: true, withFileTypes: true })
  .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
  .map((entry) => join(entry.parentPath, entry.name))
  .toSorted(compareCodeUnits);

const BAIL_CORPUS = "bail";

/** The fixture whose comments the harness cases feed their parsers. */
const SAMPLE_FIXTURE = "bail/sample";

/** The command that rewrites every golden from the current output. */
const UPDATE_COMMAND = "npx vitest run --project integration -u";

/** Opening the session and rewriting every file of a corpus, on a slow CI runner. */
const CORPUS_TIMEOUT_MS = 180_000;

/** Starts an expected-diagnostic comment, which marks the line below it. */
const EXPECT_PREFIX = "// expect-diagnostic:";

/**
 * A line that mentions an expected-diagnostic comment anywhere, near misses included, so a misspelled
 * one, or one that does not stand alone as a line comment, fails.
 */
const EXPECT_MARKER = /expect[-_ ]?diagnostics?\b/iu;

/**
 * The grammar of an expected-diagnostic comment: "warning" for a reason reported in every build, the
 * code, the ID, the 1-based column of the call on the line below, and, in backticks, the detail the
 * reason's text substitutes when it has one.
 */
const EXPECT_COMMENT =
  /^\/\/ expect-diagnostic: (warning )?(\d+) ([A-Z_]+) ([1-9]\d*)(?: `(.+)`)?$/u;

const EXPECT_GRAMMAR = `${EXPECT_PREFIX} [warning ]<code> <ID> <column>[ \`<detail>\`]`;

/** Starts a rewrite claim: a comment saying the fixture's rewrite applies the rule it names. */
const CLAIM_PREFIX = "// rewrite-applies:";

/**
 * A line that mentions a rewrite claim anywhere, near misses included, so a misspelled one, or one
 * that does not stand alone as a line comment, fails.
 */
const CLAIM_MARKER = /rewrite[-_ ]?(?:apply|applies)\b/iu;

/** The grammar of a rewrite claim: the name of one rule of the rewrite catalog. */
const CLAIM_COMMENT = /^\/\/ rewrite-applies: ([a-z-]+)$/u;

/** One diagnostic a fixture's expect-diagnostic comment calls for. */
interface Expected {
  readonly file: string;
  readonly id: string;
  readonly line: number;
  readonly column: number;
  readonly code: number;
  readonly detail: string | undefined;
  readonly warning: boolean;
}

/** One diagnostic as the harness compares it: where, which reason with which detail, and in which category. */
interface Found {
  readonly file: string;
  readonly id: string;
  readonly category: BailDiagnostic["category"];
  readonly line: number;
  readonly column: number;
  readonly code: number;
  readonly detail: string | undefined;
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

/** One rule a fixture's rewrite claim says its rewrite applies, with the file and line of the claim. */
interface Claim {
  readonly file: string;
  readonly line: number;
  readonly rule: Rule;
}

/** A claim of a fixture whose rewrite does not apply the rule the claim names. */
interface ClaimGap {
  readonly fixture: string;
  readonly claim: Claim;
}

/** A directory, outside every fixture, in which one run over the corpus reported diagnostics. */
interface Stray {
  readonly run: "strict" | "lenient";
  readonly dir: string;
}

/** What rewriting every file of a corpus gave, with the sites, plan, and applied rules of each file. */
interface CorpusRun {
  readonly modules: ReadonlyMap<string, RewrittenModule>;
  readonly analyzed: ReadonlyMap<string, readonly Site[]>;
  readonly planned: ReadonlyMap<string, PlanResult>;
  readonly applied: ReadonlyMap<string, ReadonlySet<Rule>>;
}

/** The catalog's reason for each reported code. */
const REASONS_BY_CODE: ReadonlyMap<number, ReasonInfo> = new Map(
  REASONS.map(reasonInfo).flatMap((info) =>
    info.code === undefined ? [] : [[info.code, info] as const],
  ),
);

const RULE_NAMES: ReadonlySet<string> = new Set(RULES);

/** Whether the text of `info` substitutes a bail's detail. */
function hasDetail(info: ReasonInfo): boolean {
  return info.text.includes(DETAIL_PLACEHOLDER);
}

/**
 * The detail `message` carries for the reason `info`, read from where the reason's text places it.
 *
 * @param info - The reason the message reports.
 * @param message - The diagnostic's message.
 * @returns The text standing in the placeholder, or `undefined` when the reason substitutes no
 *   detail or the message does not hold the reason's text around it.
 */
function detailOf(info: ReasonInfo | undefined, message: string): string | undefined {
  if (info === undefined || !hasDetail(info)) return undefined;
  const [before = "", after = ""] = info.text.split(DETAIL_PLACEHOLDER);
  const start = message.indexOf(before);
  const end = message.lastIndexOf(after);
  if (start === -1 || end < start + before.length) return undefined;
  return message.slice(start + before.length, end);
}

/** Whether `name` names a rule of the rewrite catalog. */
function isRule(name: string): name is Rule {
  return RULE_NAMES.has(name);
}

/** The diagnostic `comment`, on 1-based `line` of `file` in `fixture`, calls for; throws naming the line when malformed. */
function parseExpectation(fixture: string, file: string, comment: string, line: number): Expected {
  const at = `fixture ${fixture}: ${file}:${line}`;
  const match = EXPECT_COMMENT.exec(comment);
  if (match === null) {
    throw new Error(
      `${at}: ${JSON.stringify(comment)} does not read ${JSON.stringify(EXPECT_GRAMMAR)}`,
    );
  }
  const [, mark, codeText = "", id = "", columnText = "", detail] = match;
  const code = Number(codeText);
  const info = REASONS_BY_CODE.get(code);
  if (info?.id !== id) {
    throw new Error(`${at}: ${code} ${id} names no reported reason of the catalog`);
  }
  const warning = mark !== undefined;
  const isWarning = info.category === "warning";
  if (warning !== isWarning) {
    throw new Error(`${at}: ${id} is marked warning = ${warning}, want ${isWarning}`);
  }
  const takesDetail = hasDetail(info);
  if ((detail !== undefined) !== takesDetail) {
    const want = takesDetail ? "needs" : "takes no";
    throw new Error(`${at}: ${id} ${want} a detail`);
  }
  return { file, id, line: line + 1, column: Number(columnText), code, detail, warning };
}

/** Every diagnostic the comments of `content`, the text of `file` in `fixture`, call for, in line order. */
function fileExpectations(fixture: string, file: string, content: string): Expected[] {
  return content.split("\n").flatMap((text, i) => {
    const comment = text.trim();
    return EXPECT_MARKER.test(comment) ? [parseExpectation(fixture, file, comment, i + 1)] : [];
  });
}

/**
 * Reads every `.ts` file of `fixture`, held in `dir`, with `read`.
 *
 * @param fixture - The fixture whose files are read.
 * @param dir - The directory that holds the fixture's files.
 * @param read - Reads one file: the fixture, the file's name, and its text.
 * @returns What `read` gave, in file order.
 */
function readFixtureFiles<T>(
  fixture: string,
  dir: string,
  read: (fixture: string, file: string, content: string) => T[],
): T[] {
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
    .map((entry) => entry.name)
    .toSorted()
    .flatMap((name) => read(fixture, name, readFileSync(join(dir, name), "utf8")));
}

/** Every diagnostic the `.ts` files of `fixture` call for, in file then line order. */
function readExpectations(fixture: string): Expected[] {
  return readFixtureFiles(fixture, fixturePath(fixture, ""), fileExpectations);
}

/** Every rule the rewrite claims in `content`, the text of `file` in `fixture`, name, in line order. */
function claimsIn(fixture: string, file: string, content: string): Claim[] {
  return content.split("\n").flatMap((text, i) => {
    const comment = text.trim();
    if (!CLAIM_MARKER.test(comment)) return [];
    const at = `fixture ${fixture}: ${file}:${i + 1}`;
    const name = CLAIM_COMMENT.exec(comment)?.[1];
    if (name === undefined) {
      throw new Error(`${at}: ${JSON.stringify(comment)} does not read "${CLAIM_PREFIX} <rule>"`);
    }
    if (!isRule(name)) {
      throw new Error(`${at}: ${name} names no rule of the rewrite catalog`);
    }
    return [{ file, line: i + 1, rule: name }];
  });
}

/** Every rule the rewrite claims in the `.ts` files of `fixture`, held in `dir`, name, in file then line order. */
function readClaims(fixture: string, dir = fixturePath(fixture, "")): Claim[] {
  return readFixtureFiles(fixture, dir, claimsIn);
}

/** The message of a fixture whose output differs from its golden, naming the command that rewrites it. */
function goldenMismatch(fixture: string): string {
  return `fixture ${fixture}: output differs from ${GOLDEN_FILE}; run ${UPDATE_COMMAND} to rewrite it`;
}

/** The rules the rewrites of the files of `fixture` applied in `run`. */
function appliedIn(run: CorpusRun, fixture: string): Set<Rule> {
  const rules = new Set<Rule>();
  for (const [file, applied] of run.applied) {
    if (fixtureOf(file) !== fixture) continue;
    for (const rule of applied) rules.add(rule);
  }
  return rules;
}

/** `list` sorted by file, line, column, code, then category. */
function sortedFound(list: readonly Found[]): Found[] {
  return list.toSorted((a, b) => {
    const byFile = a.file.localeCompare(b.file);
    if (byFile !== 0) return byFile;
    if (a.line !== b.line) return a.line - b.line;
    if (a.column !== b.column) return a.column - b.column;
    if (a.code !== b.code) return a.code - b.code;
    return a.category.localeCompare(b.category);
  });
}

/** The diagnostics `all` call for: every one as an error under strict, only the warning ones otherwise. */
function wanted(all: readonly Expected[], strict: boolean): Found[] {
  return sortedFound(
    all
      .filter((e) => strict || e.warning)
      .map(({ file, id, line, column, code, detail }) => ({
        file,
        id,
        category: strict ? "error" : "warning",
        line,
        column,
        code,
        detail,
      })),
  );
}

/** A diagnostic as the harness compares it, with its file named by base name. */
function foundOf({ file, category, line, column, code, message }: BailDiagnostic): Found {
  const info = REASONS_BY_CODE.get(code);
  return {
    file: basename(file),
    id: info?.id ?? "",
    category,
    line,
    column,
    code,
    detail: detailOf(info, message),
  };
}

/** `diagnostics` grouped by the fixture directory of their file, each group sorted. */
function diagnosticsByFixture(diagnostics: readonly BailDiagnostic[]): Map<string, Found[]> {
  const byFixture = Map.groupBy(diagnostics, ({ file }) => fixtureOf(file));
  return new Map(
    [...byFixture].map(([fixture, group]) => [fixture, sortedFound(group.map(foundOf))]),
  );
}

/** Every directory of the strict and then the lenient run's diagnostics that is none of `fixtures`. */
function strayDiagnostics(
  fixtures: readonly string[],
  strict: ReadonlyMap<string, readonly Found[]>,
  lenient: ReadonlyMap<string, readonly Found[]>,
): Stray[] {
  const runs = [
    { run: "strict", byFixture: strict },
    { run: "lenient", byFixture: lenient },
  ] as const;
  return runs.flatMap(({ run, byFixture }) =>
    [...byFixture.keys()]
      .toSorted()
      .filter((dir) => !fixtures.includes(dir))
      .map((dir) => ({ run, dir })),
  );
}

/**
 * Compares each fixture's rewrite claims with the rules its rewrite applied.
 *
 * @param claimed - The claims each fixture makes, keyed by fixture.
 * @param applied - The rules each fixture's rewrite applied, keyed by fixture.
 * @returns `gaps`, every claim whose fixture's rewrite does not apply its rule, in fixture then
 *   claim order; and `uncovered`, every catalog rule that no claim the rewrite bears out names.
 */
function catalogGaps(
  claimed: ReadonlyMap<string, readonly Claim[]>,
  applied: ReadonlyMap<string, ReadonlySet<Rule>>,
): { gaps: ClaimGap[]; uncovered: Rule[] } {
  const covered = new Set<Rule>();
  const gaps: ClaimGap[] = [];
  for (const fixture of [...claimed.keys()].toSorted()) {
    for (const claim of claimed.get(fixture) ?? []) {
      if (applied.get(fixture)?.has(claim.rule) === true) {
        covered.add(claim.rule);
      } else {
        gaps.push({ fixture, claim });
      }
    }
  }
  return { gaps, uncovered: RULES.filter((rule) => !covered.has(rule)) };
}

/** Rewrites every one of `files` in one view of `session`, recording each file's sites, plan, and applied rules. */
async function rewriteAll(session: Session, files: readonly string[]): Promise<CorpusRun> {
  const view = await session.update();
  const analyzed = new Map<string, readonly Site[]>();
  const planned = new Map<string, PlanResult>();
  const emitted = new Map<string, EmitFile>();
  const seams: RewriteSeams = {
    analyze: async (checker, source, roots) => {
      const analysis = await analyze(checker, source, roots);
      const file = sourceFileName(source);
      analyzed.set(file, analysis.sites);
      planned.set(file, plan(analysis.sites));
      return analysis;
    },
    inline: (file, inlining, uses) => {
      file.inline(inlining, uses);
      emitted.set(inlining.pos.file, file);
    },
  };
  const rewriter = createRewriter(session, seams);
  const modules = new Map<string, RewrittenModule>();
  for (const file of files) {
    modules.set(file, await rewriter.rewrite(view, file));
  }
  const applied = new Map(
    [...emitted].map(([file, emit]) => [file, new Set(emit.applied())] as const),
  );
  return { modules, analyzed, planned, applied };
}

/** `site` followed by every site nested in its callback, depth first. */
function withNested(site: Site): Site[] {
  return [site, ...site.nested.flatMap(withNested)];
}

/** Whether `site` is an each call over one storage, with a filter and an inline callback. */
function isFilteredInlineEach(site: Site): boolean {
  return site.op === "each" && site.filtered && !site.arrayLiteral && site.callback !== undefined;
}

/**
 * Every filtered single-storage each call with an inline callback that keeps its runtime call in
 * `run`'s output, nested calls included: one its plan bails on, one whose planned rewrite failed to
 * emit, and one the plan neither rewrites nor bails on.
 *
 * @param run - The run whose sites, plans, and rewritten modules are read.
 * @returns Each such call with the reason its module's bail gives, sorted by file then line.
 */
function keptFilteredCalls(run: CorpusRun): KeptCall[] {
  return [...run.analyzed]
    .flatMap(([file, sites]) => {
      const rewritten = new Set(run.planned.get(file)?.rewrites.map(({ call }) => call));
      const bailed = new Map(moduleOf(run, file).bails.map((bail) => [bail.call, bail]));
      return sites
        .flatMap(withNested)
        .filter(
          (site) =>
            isFilteredInlineEach(site) && (bailed.has(site.call) || !rewritten.has(site.call)),
        )
        .map((site) => ({
          file: relativePath(REPO_ROOT, file),
          line: site.pos.line,
          reason: bailed.get(site.call)?.reason,
        }));
    })
    .toSorted((a, b) => (a.file === b.file ? a.line - b.line : compareCodeUnits(a.file, b.file)));
}

/** The module `run` rewrote from `file`; throws when the run did not rewrite it. */
function moduleOf(run: CorpusRun, file: string): RewrittenModule {
  const module = run.modules.get(file);
  if (module === undefined) throw new Error(`${file} was not rewritten`);
  return module;
}

/** Every diagnostic of `run`'s bails and file bails, as a build in `strict` mode reports them. */
function runDiagnostics(run: CorpusRun, strict: boolean): readonly BailDiagnostic[] {
  const bails: (Bail | FileBail)[] = [];
  for (const module of run.modules.values()) {
    bails.push(...module.bails);
    if (module.fileBail !== undefined) bails.push(module.fileBail);
  }
  return bailDiagnostics(bails, strict);
}

/** The 1-based line of `index` in `text`. */
function lineOf(text: string, index: number): number {
  return text.slice(0, index).split("\n").length;
}

/**
 * The kept call the one occurrence of a snippet opens in a repository file, whose plan neither
 * rewrites nor bails it.
 *
 * @param file - The slash-separated path of the file, relative to the repository.
 * @param snippet - The source text that opens the call.
 * @returns The kept call, on the 1-based line where `snippet` starts.
 * @throws When `snippet` occurs in `file` zero times or more than once.
 */
function keptCall(file: string, snippet: string): KeptCall {
  const text = readFileSync(join(REPO_ROOT, file), "utf8");
  if (text.split(snippet).length !== 2) throw new Error(`${file} must hold one ${snippet}`);
  return { file, line: lineOf(text, text.indexOf(snippet)), reason: "OP_NOT_REWRITTEN" };
}

/** The 1-based line on which the each call of the iteration/helper_call benchmark starts in `text`. */
function helperCallLine(text: string): number {
  const call = advanceCall(text);
  const each = text.lastIndexOf("each(", call);
  if (each < 0) {
    throw new Error(
      `iteration-bench.ts has no each call ahead of its helper call at line ${lineOf(text, call)}`,
    );
  }
  return lineOf(text, each);
}

/** Each storage form the shape analysis distinguishes, with its fixture and whether its shape resolves. */
const SHAPE_ROWS = [
  { row: "local storage", fixture: "eligible/local-storage", resolves: true },
  { row: "class-form archetype", fixture: "eligible/class-archetype", resolves: true },
  {
    row: "parameter typed Storage<typeof X>",
    fixture: "eligible/typed-parameter",
    resolves: true,
  },
  { row: "parameter typed Storage<X>", fixture: "shape/class-storage-parameter", resolves: true },
  {
    row: "storage imported from another module",
    fixture: "eligible/imported-storage",
    resolves: true,
  },
  { row: "class field", fixture: "shape/class-field", resolves: true },
  { row: "property chain", fixture: "shape/property-chain", resolves: true },
  { row: "call result", fixture: "shape/call-result", resolves: true },
  { row: "getStorage", fixture: "shape/get-storage", resolves: true },
  {
    row: "generic constrained to a storage type",
    fixture: "shape/constrained-generic",
    resolves: true,
  },
  { row: "as cast", fixture: "shape/as-cast", resolves: true },
  { row: "wide Storage", fixture: "bail/shape-unresolved", resolves: false },
  {
    row: "union of storages of different shapes",
    fixture: "shape/union-of-shapes",
    resolves: false,
  },
  { row: "any", fixture: "shape/any-storage", resolves: false },
  { row: "unknown", fixture: "shape/unknown-storage", resolves: false },
  {
    row: "unconstrained type parameter",
    fixture: "shape/unconstrained-type-parameter",
    resolves: false,
  },
  {
    row: "component tuple built by a conditional type",
    fixture: "shape/conditional-components",
    resolves: false,
  },
  {
    row: "component tuple built by a mapped type",
    fixture: "shape/mapped-components",
    resolves: false,
  },
  { row: "optional tuple element", fixture: "shape/optional-element", resolves: false },
  { row: "rest tuple element", fixture: "shape/rest-element", resolves: false },
  { row: "variadic tuple element", fixture: "shape/variadic-element", resolves: false },
  { row: "union-typed tuple element", fixture: "shape/union-component-element", resolves: false },
];

describe("fixture corpus", () => {
  let session: Session;
  let run: CorpusRun;
  let strictFound: Map<string, Found[]>;
  let lenientFound: Map<string, Found[]>;

  beforeAll(async () => {
    session = await openSession(join(CORPUS_ROOT, "tsconfig.json"));
    run = await rewriteAll(session, CORPUS_FILES);
    strictFound = diagnosticsByFixture(runDiagnostics(run, true));
    lenientFound = diagnosticsByFixture(runDiagnostics(run, false));
  }, CORPUS_TIMEOUT_MS);

  afterAll(() => session.close());

  describe.each(FIXTURES)("fixture %s", (fixture) => {
    const all = readExpectations(fixture);
    const input = fixturePath(fixture, INPUT_FILE);

    it("output equals the golden", async () => {
      const text = moduleOf(run, input).output?.text ?? readFileSync(input, "utf8");

      // oxlint-disable-next-line vitest/valid-expect -- Vitest's `expect(value, message)` form; the rule accepts the message only as a literal
      await expect(text, goldenMismatch(fixture)).toMatchFileSnapshot(
        fixturePath(fixture, GOLDEN_FILE),
      );
    });

    it.each([
      { mode: "strict", strict: true, found: () => strictFound },
      { mode: "lenient", strict: false, found: () => lenientFound },
    ])("$mode diagnostics equal the comments the mode reports", ({ strict, found }) => {
      expect(found().get(fixture) ?? []).toStrictEqual(wanted(all, strict));
    });

    it("output is rewritten exactly when a site plans a rewrite", () => {
      const rewrites = run.planned.get(input)?.rewrites.length ?? 0;

      const rewritten = moduleOf(run, input).output !== undefined;

      expect({ rewritten }).toStrictEqual({ rewritten: rewrites > 0 });
    });

    it.runIf(all.length === 0)("plans a rewrite, as it expects no diagnostic", () => {
      expect(run.planned.get(input)?.rewrites.length ?? 0).toBeGreaterThan(0);
    });
  });

  it("reports no diagnostic outside a fixture directory", () => {
    expect(strayDiagnostics(FIXTURES, strictFound, lenientFound)).toStrictEqual([]);
  });

  it("applies every rule of the catalog in a fixture that claims it", () => {
    const claimed = new Map(FIXTURES.map((fixture) => [fixture, readClaims(fixture)]));
    const applied = new Map(FIXTURES.map((fixture) => [fixture, appliedIn(run, fixture)]));

    const { gaps, uncovered } = catalogGaps(claimed, applied);

    expect({ gaps, uncovered }).toStrictEqual({ gaps: [], uncovered: [] });
  });
});

describe("reported reasons", () => {
  it("each have a bail fixture whose expect-diagnostic comment names it", () => {
    const named = new Set(
      FIXTURES.filter((fixture) => fixture.startsWith(`${BAIL_CORPUS}/`)).flatMap((fixture) =>
        readExpectations(fixture).map(({ id }) => id),
      ),
    );

    const unnamed = REASONS.map(reasonInfo)
      .filter(({ category }) => category === "strict" || category === "warning")
      .filter(({ id }) => id !== "INTERNAL" && !named.has(id))
      .map(({ id }) => id);

    expect(unnamed).toStrictEqual([]);
  });
});

describe("storage shape fixtures", () => {
  it.each(SHAPE_ROWS)(
    "$row has fixture $fixture expecting the shape to resolve: $resolves",
    ({ fixture, resolves }) => {
      const ids = FIXTURES.includes(fixture)
        ? readExpectations(fixture).map(({ id }) => id)
        : undefined;

      expect(ids).toStrictEqual(resolves ? [] : ["SHAPE_UNRESOLVED"]);
    },
  );
});

describe("benchmarks", () => {
  const systemsFile = join(BENCHMARK_ROOT, "systems.ts");
  const iterationFile = join(BENCHMARK_ROOT, "iteration-bench.ts");
  let session: Session;
  let run: CorpusRun;

  beforeAll(async () => {
    session = await openSession(join(BENCHMARK_ROOT, "tsconfig.json"));
    run = await rewriteAll(session, [systemsFile, iterationFile]);
  }, CORPUS_TIMEOUT_MS);

  afterAll(() => session.close());

  it("compile every each call of the systems hoisted", () => {
    const systems = run.planned.get(systemsFile);

    expect(systems?.bails).toStrictEqual([]);
    expect(systems?.rewrites).not.toHaveLength(0);
    expect(
      systems?.rewrites.filter(({ mode }) => mode !== "hoisted").map(({ pos }) => pos.line),
    ).toStrictEqual([]);
  });

  it("compile the helper_call each call realloc-safe", () => {
    const line = helperCallLine(readFileSync(iterationFile, "utf8"));

    const modes = run.planned
      .get(iterationFile)
      ?.rewrites.filter(({ pos }) => pos.line === line)
      .map(({ mode }) => mode);

    expect(modes).toStrictEqual(["realloc-safe"]);
  });
});

describe("unit suite", () => {
  let session: Session;
  let run: CorpusRun;

  beforeAll(async () => {
    session = await openSession(join(REPO_ROOT, "tests", "tsconfig.json"));
    run = await rewriteAll(session, UNIT_FILES);
  }, CORPUS_TIMEOUT_MS);

  afterAll(() => session.close());

  // The kept calls, sorted by file then line, each located by the source snippet that opens it:
  // a number as the filter matches no filter form, and the outer call holds an inlined each.
  it("rewrites every filtered single-storage each with an inline callback but the kept ones", () => {
    const expected = [
      keptCall("tests/unit/entity/each.test.ts", "each(storage, 42,"),
      keptCall("tests/unit/filter.test.ts", "each(storage, { all: [Stunned] }, (outer) =>"),
    ];

    const kept = keptFilteredCalls(run);

    expect(kept).toStrictEqual(expected);
  });
});

describe("expect-diagnostic comments", () => {
  const shape = reasonInfo("SHAPE_UNRESOLVED");
  const async = reasonInfo("CALLBACK_ASYNC");
  const escapes = reasonInfo("VIEW_ESCAPES");
  const internal = reasonInfo("INTERNAL");
  const escape = "line 9, column 12: the view as a value";

  it.each([
    {
      name: "a strict reason as code, ID, then column",
      comment: `// expect-diagnostic: ${shape.code} ${shape.id} 3`,
      expected: {
        file: INPUT_FILE,
        id: shape.id,
        line: 8,
        column: 3,
        code: shape.code,
        detail: undefined,
        warning: false,
      },
    },
    {
      name: "a warning reason after the warning mark",
      comment: `// expect-diagnostic: warning ${async.code} ${async.id} 15`,
      expected: {
        file: INPUT_FILE,
        id: async.id,
        line: 8,
        column: 15,
        code: async.code,
        detail: undefined,
        warning: true,
      },
    },
    {
      name: "a reason with a detail, the detail in backticks after the column",
      comment: `// expect-diagnostic: ${escapes.code} ${escapes.id} 3 \`${escape}\``,
      expected: {
        file: INPUT_FILE,
        id: escapes.id,
        line: 8,
        column: 3,
        code: escapes.code,
        detail: escape,
        warning: false,
      },
    },
    {
      name: "the internal reason with its detail",
      comment: `// expect-diagnostic: ${internal.code} ${internal.id} 5 \`Error: banana\``,
      expected: {
        file: INPUT_FILE,
        id: internal.id,
        line: 8,
        column: 5,
        code: internal.code,
        detail: "Error: banana",
        warning: false,
      },
    },
  ])("parse $name, marking the line below", ({ comment, expected }) => {
    const parsed = parseExpectation(SAMPLE_FIXTURE, INPUT_FILE, comment, 7);

    expect(parsed).toStrictEqual(expected);
  });

  it.each([
    { name: "ID before code", comment: `${EXPECT_PREFIX} ${shape.id} ${shape.code} 3` },
    {
      name: "trailing warning mark",
      comment: `${EXPECT_PREFIX} ${async.code} ${async.id} 3 warning`,
    },
    { name: "missing ID", comment: `${EXPECT_PREFIX} ${shape.code} 3` },
    { name: "missing column", comment: `${EXPECT_PREFIX} ${shape.code} ${shape.id}` },
    { name: "column zero", comment: `${EXPECT_PREFIX} ${shape.code} ${shape.id} 0` },
    { name: "column not a number", comment: `${EXPECT_PREFIX} ${shape.code} ${shape.id} three` },
    {
      name: "ID and code of different reasons",
      comment: `${EXPECT_PREFIX} ${shape.code} ${async.id} 3`,
    },
    { name: "code outside the catalog", comment: `${EXPECT_PREFIX} 12345 ${shape.id} 3` },
    {
      name: "warning mark on a strict reason",
      comment: `${EXPECT_PREFIX} warning ${shape.code} ${shape.id} 3`,
    },
    {
      name: "warning reason without the mark",
      comment: `${EXPECT_PREFIX} ${async.code} ${async.id} 3`,
    },
    {
      name: "a detail reason without its detail",
      comment: `${EXPECT_PREFIX} ${escapes.code} ${escapes.id} 3`,
    },
    {
      name: "the internal reason without its detail",
      comment: `${EXPECT_PREFIX} ${internal.code} ${internal.id} 3`,
    },
    {
      name: "a detail on a reason without one",
      comment: `${EXPECT_PREFIX} ${shape.code} ${shape.id} 3 \`${escape}\``,
    },
    {
      name: "a detail outside backticks",
      comment: `${EXPECT_PREFIX} ${escapes.code} ${escapes.id} 3 ${escape}`,
    },
    {
      name: "an empty detail",
      comment: `${EXPECT_PREFIX} ${escapes.code} ${escapes.id} 3 \`\``,
    },
    { name: "plural keyword", comment: `// expect-diagnostics: ${shape.code} ${shape.id} 3` },
    {
      name: "no space after the slashes",
      comment: `//expect-diagnostic: ${shape.code} ${shape.id} 3`,
    },
    { name: "no colon", comment: `// expect-diagnostic ${shape.code} ${shape.id} 3` },
    {
      name: "after code on its line",
      comment: `export const kiwi = 2; ${EXPECT_PREFIX} ${shape.code} ${shape.id} 3`,
    },
    {
      name: "in a block comment",
      comment: `/* expect-diagnostic: ${shape.code} ${shape.id} 3 */`,
    },
  ])("reject $name, naming the fixture and line", ({ comment }) => {
    const content = `export const banana = 1;\n  ${comment}\nconsole.log(banana);\n`;

    expect(() => fileExpectations(SAMPLE_FIXTURE, INPUT_FILE, content)).toThrow(
      `fixture ${SAMPLE_FIXTURE}: ${INPUT_FILE}:2:`,
    );
  });
});

describe("foundOf", () => {
  const pos = {
    file: join(CORPUS_ROOT, SAMPLE_FIXTURE, INPUT_FILE),
    offset: 40,
    line: 4,
    column: 3,
  };

  it.each([
    { reason: "VIEW_ESCAPES", detail: "line 5, column 7: a key outside the shape", strict: true },
    { reason: "INTERNAL", detail: "Error: banana (`kiwi`)", strict: true },
    { reason: "INTERNAL", detail: "Error: banana (`kiwi`)", strict: false },
  ] as const)(
    "reads the $reason detail from the message, strict $strict",
    ({ reason, detail, strict }) => {
      const [diagnostic] = bailDiagnostics([{ call: 40, op: "each", reason, pos, detail }], strict);

      const found = diagnostic === undefined ? undefined : foundOf(diagnostic);

      expect(found?.detail).toBe(detail);
    },
  );

  it("reads a diagnostic whose reason has no detail, its file by base name", () => {
    const [diagnostic] = bailDiagnostics(
      [{ call: 40, op: "each", reason: "SHAPE_UNRESOLVED", pos }],
      true,
    );

    const found = diagnostic === undefined ? undefined : foundOf(diagnostic);

    expect(found).toStrictEqual({
      file: INPUT_FILE,
      id: "SHAPE_UNRESOLVED",
      category: "error",
      line: 4,
      column: 3,
      code: reasonInfo("SHAPE_UNRESOLVED").code,
      detail: undefined,
    });
  });
});

describe("rewrite-applies comments", () => {
  const [first, second] = RULES;

  it("are read in line order, one rule each", () => {
    const content = `export const banana = 1;\n${CLAIM_PREFIX} ${first}\n  ${CLAIM_PREFIX} ${second}\n`;

    const claims = claimsIn(SAMPLE_FIXTURE, INPUT_FILE, content);

    expect(claims).toStrictEqual([
      { file: INPUT_FILE, line: 2, rule: first },
      { file: INPUT_FILE, line: 3, rule: second },
    ]);
  });

  it.each([
    { name: "a name outside the catalog", comment: `${CLAIM_PREFIX} banana` },
    { name: "two rules on one line", comment: `${CLAIM_PREFIX} ${first}, ${second}` },
    { name: "no colon", comment: `// rewrite-applies ${first}` },
    { name: "singular keyword", comment: `// rewrite-apply: ${first}` },
    { name: "after code on its line", comment: `export const kiwi = 2; ${CLAIM_PREFIX} ${first}` },
    { name: "in a block comment", comment: `/* rewrite-applies: ${first} */` },
  ])("reject $name, naming the fixture and line", ({ comment }) => {
    const content = `export const banana = 1;\n${comment}\n`;

    expect(() => claimsIn(SAMPLE_FIXTURE, INPUT_FILE, content)).toThrow(
      `fixture ${SAMPLE_FIXTURE}: ${INPUT_FILE}:2:`,
    );
  });
});

describe("readClaims", () => {
  afterEach(removeTempDirs);

  it("rejects a malformed claim in a companion file, naming that file and line", () => {
    const dir = createProject({
      [INPUT_FILE]: "export const banana = 1;\n",
      "storage.ts": `export const kiwi = 2;\n${CLAIM_PREFIX} banana\n`,
    });

    expect(() => readClaims(SAMPLE_FIXTURE, dir)).toThrow(
      `fixture ${SAMPLE_FIXTURE}: storage.ts:2:`,
    );
  });
});

describe("catalogGaps", () => {
  const [firstRule, secondRule] = RULES;
  const everyClaim = RULES.map((rule, i) => ({ file: INPUT_FILE, line: i + 1, rule }));
  const first = { file: INPUT_FILE, line: 1, rule: firstRule };
  const all: ReadonlySet<Rule> = new Set(RULES);

  it.each([
    {
      name: "a claim its fixture's rewrite does not apply is a gap and covers nothing",
      claimed: new Map([[SAMPLE_FIXTURE, [first]]]),
      applied: new Map([[SAMPLE_FIXTURE, new Set([secondRule])]]),
      expected: { gaps: [{ fixture: SAMPLE_FIXTURE, claim: first }], uncovered: [...RULES] },
    },
    {
      name: "a rule applied only by another fixture's rewrite does not bear the claim out",
      claimed: new Map([
        [SAMPLE_FIXTURE, [first]],
        ["each/banana", []],
      ]),
      applied: new Map([["each/banana", new Set([firstRule])]]),
      expected: { gaps: [{ fixture: SAMPLE_FIXTURE, claim: first }], uncovered: [...RULES] },
    },
    {
      name: "a rule no fixture claims is uncovered even when a rewrite applies it",
      claimed: new Map([[SAMPLE_FIXTURE, everyClaim.slice(1)]]),
      applied: new Map([[SAMPLE_FIXTURE, all]]),
      expected: { gaps: [], uncovered: [firstRule] },
    },
    {
      name: "every rule claimed and applied leaves no gap",
      claimed: new Map([[SAMPLE_FIXTURE, everyClaim]]),
      applied: new Map([[SAMPLE_FIXTURE, all]]),
      expected: { gaps: [], uncovered: [] },
    },
  ])("$name", ({ claimed, applied, expected }) => {
    const gaps = catalogGaps(claimed, applied);

    expect(gaps).toStrictEqual(expected);
  });
});

describe("strayDiagnostics", () => {
  const shape = reasonInfo("SHAPE_UNRESOLVED");
  const diagnostic: Found[] = [
    {
      file: "schema.ts",
      id: shape.id,
      category: "error",
      line: 3,
      column: 1,
      code: shape.code ?? 0,
      detail: undefined,
    },
  ];
  const none = new Map<string, Found[]>();

  it.each([
    {
      name: "reports a strict run's diagnostics outside a fixture",
      strict: new Map([[".", diagnostic]]),
      lenient: none,
      expected: [{ run: "strict", dir: "." }],
    },
    {
      name: "reports a lenient run's diagnostics outside a fixture",
      strict: none,
      lenient: new Map([[".", diagnostic]]),
      expected: [{ run: "lenient", dir: "." }],
    },
    {
      name: "reports nothing when both runs' diagnostics sit inside a fixture",
      strict: new Map([[SAMPLE_FIXTURE, diagnostic]]),
      lenient: new Map([[SAMPLE_FIXTURE, diagnostic]]),
      expected: [],
    },
  ])("$name", ({ strict, lenient, expected }) => {
    const strays = strayDiagnostics([SAMPLE_FIXTURE], strict, lenient);

    expect(strays).toStrictEqual(expected);
  });
});
