import { existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, posix, sep } from "node:path";

import { LanguageVariant, type Node, type SourceFile, SyntaxKind } from "typescript/ast";
import { isCallExpression, isPropertyAccessExpression } from "typescript/ast/is";
import {
  computeLineStarts,
  createScanner,
  tokenIsIdentifierOrKeyword,
} from "typescript/ast/scanner";
import { API, type Project, type Symbol as CheckerSymbol, SymbolFlags } from "typescript/sync";

import { writeProject } from "./project.js";

/** A module's source, keyed by its slash-separated path from the checked directory. */
export interface Module {
  readonly path: string;
  readonly text: string;
}

interface Token {
  readonly kind: SyntaxKind;
  readonly value: string;
  readonly line: number;
}

interface Import {
  readonly specifier: string;
  /** The imported path from the checked directory, for a relative specifier. */
  readonly target: string | undefined;
  readonly line: number;
}

interface Reference {
  readonly name: string;
  readonly line: number;
}

interface ScannedModule {
  readonly path: string;
  readonly imports: readonly Import[];
  readonly calls: readonly Reference[];
  readonly receivers: readonly Reference[];
}

type Rule = (modules: readonly ScannedModule[]) => string[];

/** Names whose members are compiler calls whatever the member is called. */
const COMPILER_RECEIVERS: ReadonlySet<string> = new Set([
  "checker",
  "program",
  "snapshot",
  "printer",
]);

const COMPILER_MODULE = "compiler.ts";
const PURE_MODULES: ReadonlySet<string> = new Set(["facts.ts", "plan.ts"]);
const SYNTAX_MODULE = "syntax.ts";
const COMPILER_ENTRIES: ReadonlySet<string> = new Set(["typescript/async", "typescript/sync"]);

const EMIT_DIR = "emit/";
const ANALYSIS_DIR = "analysis/";

const TSGO = "only compiler.ts reaches tsgo";
const PURE = "facts.ts and plan.ts import nothing from typescript";
const EMIT = "emit imports nothing from analysis";
const SYNTAX = "syntax.ts imports nothing from emit";

/** Tokens after which a slash divides rather than opening a regular expression. */
const EXPRESSION_ENDS: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.Identifier,
  SyntaxKind.ThisKeyword,
  SyntaxKind.SuperKeyword,
  SyntaxKind.TrueKeyword,
  SyntaxKind.FalseKeyword,
  SyntaxKind.NullKeyword,
  SyntaxKind.NumericLiteral,
  SyntaxKind.BigIntLiteral,
  SyntaxKind.StringLiteral,
  SyntaxKind.NoSubstitutionTemplateLiteral,
  SyntaxKind.TemplateTail,
  SyntaxKind.RegularExpressionLiteral,
  SyntaxKind.CloseParenToken,
  SyntaxKind.CloseBracketToken,
  SyntaxKind.PlusPlusToken,
  SyntaxKind.MinusMinusToken,
]);

/** Tracks brace depth and open template substitutions, so the `}` closing one resumes the template. */
class TemplateTracker {
  readonly #substitutionDepths: number[] = [];
  #depth = 0;

  /** The kind of a scanned token, read again through `readTemplate` when it closes a substitution. */
  track(kind: SyntaxKind, readTemplate: () => SyntaxKind): SyntaxKind {
    if (kind === SyntaxKind.OpenBraceToken) {
      this.#depth++;
    } else if (kind === SyntaxKind.TemplateHead) {
      this.#substitutionDepths.push(this.#depth);
    } else if (kind === SyntaxKind.CloseBraceToken) {
      return this.#closeBrace(readTemplate);
    }
    return kind;
  }

  /** The kind of a `}`: a template token when it closes a substitution, else a plain brace. */
  #closeBrace(readTemplate: () => SyntaxKind): SyntaxKind {
    if (this.#substitutionDepths.at(-1) !== this.#depth) {
      this.#depth--;
      return SyntaxKind.CloseBraceToken;
    }
    const kind = readTemplate();
    if (kind === SyntaxKind.TemplateTail) this.#substitutionDepths.pop();
    return kind;
  }
}

/** Whether a slash token after a token of kind `previous` opens a regular expression. */
function opensRegularExpression(kind: SyntaxKind, previous: SyntaxKind | undefined): boolean {
  const isSlash = kind === SyntaxKind.SlashToken || kind === SyntaxKind.SlashEqualsToken;
  return isSlash && !EXPRESSION_ENDS.has(previous ?? SyntaxKind.Unknown);
}

/** The line index at or after `line` that holds the character offset `start`. */
function advanceLine(lineStarts: readonly number[], line: number, start: number): number {
  let current = line;
  while ((lineStarts[current + 1] ?? Infinity) <= start) current++;
  return current;
}

/**
 * Scans `text` for tokens. A token scan sees no syntax tree, so it tracks template substitutions by
 * brace depth and reads a slash as a regular expression unless the previous token ends an
 * expression.
 *
 * @param text - The module source to scan.
 * @returns The tokens in source order, comments and whitespace skipped, each with its 1-based line.
 */
function tokenize(text: string): Token[] {
  const scanner = createScanner(true, LanguageVariant.Standard, text);
  const lineStarts = computeLineStarts(text);
  const readTemplate = (): SyntaxKind => scanner.reScanTemplateToken(false);
  const templates = new TemplateTracker();
  const tokens: Token[] = [];
  let line = 0;
  for (let kind = scanner.scan(); kind !== SyntaxKind.EndOfFile; kind = scanner.scan()) {
    kind = templates.track(kind, readTemplate);
    if (opensRegularExpression(kind, tokens.at(-1)?.kind)) kind = scanner.reScanSlashToken();
    line = advanceLine(lineStarts, line, scanner.getTokenStart());
    tokens.push({ kind, value: scanner.getTokenValue(), line: line + 1 });
  }
  return tokens;
}

/** The string token an `import` keyword introduces, bare or called, given the two tokens after it. */
function importSpecifier(next: Token, afterNext: Token | undefined): Token | undefined {
  const quoted = next.kind === SyntaxKind.OpenParenToken ? afterNext : next;
  return quoted?.kind === SyntaxKind.StringLiteral ? quoted : undefined;
}

function isFromClause(token: Token, next: Token): boolean {
  return (
    tokenIsIdentifierOrKeyword(token.kind) &&
    token.value === "from" &&
    next.kind === SyntaxKind.StringLiteral
  );
}

/** The specifier string token that `tokens[index]` introduces, if it introduces one. */
function specifierAfter(tokens: readonly Token[], index: number): Token | undefined {
  const token = tokens[index];
  const next = tokens[index + 1];
  if (token === undefined || next === undefined) return undefined;
  if (token.kind === SyntaxKind.ImportKeyword) return importSpecifier(next, tokens[index + 2]);
  return isFromClause(token, next) ? next : undefined;
}

/** The import `specifier` names, its target resolved against the directory of `modulePath`. */
function toImport(specifier: Token, modulePath: string): Import {
  const target = specifier.value.startsWith(".")
    ? posix.join(posix.dirname(modulePath), specifier.value)
    : undefined;
  return { specifier: specifier.value, target, line: specifier.line };
}

/** Whether `token`, followed by a token of kind `next`, reads a member of a compiler receiver. */
function isCompilerReceiver(token: Token, next: SyntaxKind | undefined): boolean {
  const isMemberAccess = next === SyntaxKind.DotToken || next === SyntaxKind.QuestionDotToken;
  const isReceiver = token.kind === SyntaxKind.Identifier && COMPILER_RECEIVERS.has(token.value);
  return isReceiver && isMemberAccess;
}

/** The imports `tokens` spell out, in source order. */
function scanImports(tokens: readonly Token[], modulePath: string): Import[] {
  const imports: Import[] = [];
  for (const index of tokens.keys()) {
    const specifier = specifierAfter(tokens, index);
    if (specifier !== undefined) imports.push(toImport(specifier, modulePath));
  }
  return imports;
}

/** The compiler receivers `tokens` read a member of, in source order. */
function scanReceivers(tokens: readonly Token[]): Reference[] {
  const receivers: Reference[] = [];
  for (const [index, token] of tokens.entries()) {
    if (isCompilerReceiver(token, tokens[index + 1]?.kind)) {
      receivers.push({ name: token.value, line: token.line });
    }
  }
  return receivers;
}

/** The imports and compiler receivers `module` spells out, beside its compiler method `calls`. */
function scan(module: Module, calls: readonly Reference[]): ScannedModule {
  const tokens = tokenize(module.text);
  return {
    path: module.path,
    imports: scanImports(tokens, module.path),
    calls,
    receivers: scanReceivers(tokens),
  };
}

/** The 1-based line of the character offset `position`. */
function lineOf(lineStarts: readonly number[], position: number): number {
  return lineStarts.findLastIndex((start) => start <= position) + 1;
}

/** The `b` name node of each `a.b()` call under `root`, in source order. */
function calledMembers(root: SourceFile): Node[] {
  const members: Node[] = [];
  const visit = (node: Node): void => {
    if (isCallExpression(node) && isPropertyAccessExpression(node.expression)) {
      members.push(node.expression.name);
    }
    node.forEachChild(visit);
  };
  visit(root);
  return members.toSorted((a, b) => a.getStart(root) - b.getStart(root));
}

function isClassOrInterface(symbol: CheckerSymbol | undefined): boolean {
  return symbol !== undefined && (symbol.flags & (SymbolFlags.Class | SymbolFlags.Interface)) !== 0;
}

/**
 * Whether `member` is declared on a class or interface the compiler API declares.
 *
 * @param member - The symbol a call's member name resolves to, if it resolves.
 * @param apiDirs - The canonical directories, slash-terminated, of the compiler API's declarations.
 * @returns Whether a declaration of `member` sits under one of `apiDirs`, on a class or interface.
 */
function isApiMember(member: CheckerSymbol | undefined, apiDirs: readonly string[]): boolean {
  if (member === undefined) return false;
  const inApi = member.declarations.some((declaration) =>
    apiDirs.some((dir) => declaration.path.startsWith(dir)),
  );
  return inApi && isClassOrInterface(member.getParent());
}

/**
 * The calls in `file` whose method the compiler API declares, resolved through `project`'s checker.
 *
 * @param project - The project whose program holds `file`.
 * @param file - The absolute path of the module checked.
 * @param apiDirs - The canonical directories, slash-terminated, of the compiler API's declarations.
 * @returns Each such call's method name and line, in source order.
 * @throws Error when `file` is not in the project's program.
 */
function apiCalls(project: Project, file: string, apiDirs: readonly string[]): Reference[] {
  const source = project.program.getSourceFile(file);
  if (source === undefined) throw new Error(`${file} is not in the project's program`);
  const members = calledMembers(source);
  const symbols = project.checker.getSymbolAtLocation(members);
  const lineStarts = computeLineStarts(source.text);
  return members.flatMap((member, index) =>
    isApiMember(symbols[index], apiDirs)
      ? [{ name: member.getText(source), line: lineOf(lineStarts, member.getStart(source)) }]
      : [],
  );
}

/** A rule reporting each module named in `paths` that is absent. */
function requireModules(paths: readonly string[]): Rule {
  return (modules) => {
    const present = new Set(modules.map((module) => module.path));
    return paths
      .filter((path) => !present.has(path))
      .map((path) => `${path} is missing: the boundary rules name it`);
  };
}

/** A rule reporting each import that `imports` matches in a module whose path `from` matches. */
function forbidImports(options: {
  readonly from: (path: string) => boolean;
  readonly imports: (imported: Import) => boolean;
  readonly reason: string;
}): Rule {
  return (modules) =>
    modules
      .filter((module) => options.from(module.path))
      .flatMap((module) =>
        module.imports
          .filter(options.imports)
          .map(
            (imported) =>
              `${module.path}:${imported.line} imports ${imported.specifier}: ${options.reason}`,
          ),
      );
}

/** A rule reporting each compiler method call and compiler receiver in a module whose path `from` matches. */
function forbidCompilerCalls(from: (path: string) => boolean, reason: string): Rule {
  return (modules) => {
    const violations: string[] = [];
    for (const module of modules) {
      if (!from(module.path)) continue;
      for (const call of module.calls) {
        violations.push(`${module.path}:${call.line} calls ${call.name}: ${reason}`);
      }
      for (const receiver of module.receivers) {
        violations.push(`${module.path}:${receiver.line} reads ${receiver.name}: ${reason}`);
      }
    }
    return violations;
  };
}

/**
 * The optimizer's boundaries: only `compiler.ts` reaches tsgo, the pure modules import no
 * `typescript`, no module under `emit/` imports one under `analysis/`, and `syntax.ts`, which both
 * share, imports nothing under `emit/`.
 */
export const OPTIMIZER_RULES: readonly Rule[] = [
  requireModules([COMPILER_MODULE, ...PURE_MODULES, SYNTAX_MODULE]),
  forbidImports({
    from: (path) => path !== COMPILER_MODULE,
    imports: (imported) => COMPILER_ENTRIES.has(imported.specifier),
    reason: TSGO,
  }),
  forbidCompilerCalls((path) => path !== COMPILER_MODULE, TSGO),
  forbidImports({
    from: (path) => PURE_MODULES.has(path),
    imports: (imported) =>
      imported.specifier === "typescript" || imported.specifier.startsWith("typescript/"),
    reason: PURE,
  }),
  forbidImports({
    from: (path) => path.startsWith(EMIT_DIR),
    imports: (imported) => imported.target?.startsWith(ANALYSIS_DIR) === true,
    reason: EMIT,
  }),
  forbidImports({
    from: (path) => path === SYNTAX_MODULE,
    imports: (imported) => imported.target?.startsWith(EMIT_DIR) === true,
    reason: SYNTAX,
  }),
];

/** A strict tsconfig for a project of synthetic modules, every `.ts` file under it included. */
const MODULES_TSCONFIG = JSON.stringify({
  compilerOptions: {
    strict: true,
    target: "es2024",
    lib: ["es2024"],
    module: "nodenext",
    noEmit: true,
    types: [],
  },
  include: ["**/*.ts"],
});

const resolver = createRequire(import.meta.url);

function slashPath(path: string): string {
  return path.split(sep).join("/");
}

/** The directories, slash-separated and slash-terminated, of the compiler API's declarations. */
const API_DIRS: readonly string[] = [...COMPILER_ENTRIES].map(
  (entry) => `${slashPath(dirname(resolver.resolve(entry)))}/`,
);

const TYPESCRIPT_DIR = dirname(resolver.resolve("typescript/package.json"));

function nearestTsconfig(dir: string): string {
  const candidate = join(dir, "tsconfig.json");
  if (existsSync(candidate)) return candidate;
  const parent = dirname(dir);
  if (parent === dir) throw new Error(`no tsconfig.json at or above ${dir}`);
  return nearestTsconfig(parent);
}

/**
 * Writes `modules` as a project under a new temp directory, linking the installed `typescript` into
 * its `node_modules` so the compiler API's declarations resolve.
 *
 * @param modules - The modules, each written at its path.
 * @returns The project directory.
 */
function writeModules(modules: readonly Module[]): string {
  const root = writeProject({
    "tsconfig.json": MODULES_TSCONFIG,
    ...Object.fromEntries(modules.map((module) => [module.path, module.text])),
  });
  mkdirSync(join(root, "node_modules"));
  symlinkSync(TYPESCRIPT_DIR, join(root, "node_modules", "typescript"), "junction");
  return root;
}

/** Checks modules against boundary rules, resolving calls through one compiler process. */
export interface BoundaryChecker {
  /**
   * Checks the modules under `dir` in place, typed by the nearest `tsconfig.json` at or above it.
   *
   * @param dir - The directory whose modules are checked.
   * @param rules - The rules to check.
   * @returns Every violation, rule by rule.
   * @throws Error when no `tsconfig.json` sits at or above `dir`, or one of its modules is not in
   *   that project.
   */
  checkDirectory(dir: string, rules: readonly Rule[]): string[];
  /**
   * Checks `modules` as a project of their own.
   *
   * @param modules - The modules checked, keyed by their path in the project.
   * @param rules - The rules to check.
   * @returns Every violation, rule by rule.
   */
  checkModules(modules: readonly Module[], rules: readonly Rule[]): string[];
  close(): void;
}

/** A checker running on a compiler process it starts; close it to stop the process. */
export function openBoundaryChecker(): BoundaryChecker {
  const api = new API();
  const check = (root: string, modules: readonly Module[], rules: readonly Rule[]): string[] => {
    const tsconfig = nearestTsconfig(root);
    const snapshot = api.createSnapshot({ openProjects: [tsconfig] });
    try {
      // The API learns the file system's case sensitivity from its first request, so canonical
      // names wait for the snapshot.
      const apiDirs = API_DIRS.map((dir) => api.getCanonicalFileName(dir));
      const project = snapshot.getConfiguredProject(tsconfig);
      if (project === undefined) throw new Error(`the compiler opened no project for ${tsconfig}`);
      const scanned = modules.map((module) =>
        scan(module, apiCalls(project, join(root, module.path), apiDirs)),
      );
      return rules.flatMap((rule) => rule(scanned));
    } finally {
      snapshot.dispose();
    }
  };
  return {
    checkDirectory: (dir, rules) => check(dir, readModules(dir), rules),
    checkModules: (modules, rules) => check(writeModules(modules), modules, rules),
    close: () => {
      api.close();
    },
  };
}

/** Every TypeScript module under `dir`, test files excluded, in path order. */
export function readModules(dir: string): Module[] {
  return readdirSync(dir, { recursive: true, encoding: "utf8" })
    .filter((rel) => rel.endsWith(".ts") && !rel.endsWith(".test.ts"))
    .toSorted()
    .map((rel) => ({ path: slashPath(rel), text: readFileSync(join(dir, rel), "utf8") }));
}
