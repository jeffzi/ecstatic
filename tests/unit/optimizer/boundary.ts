import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, posix, sep } from "node:path";

import { LanguageVariant, SyntaxKind } from "typescript/ast";
import {
  computeLineStarts,
  createScanner,
  tokenIsIdentifierOrKeyword,
} from "typescript/ast/scanner";

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

/**
 * The classes of `typescript/async` whose every method is a compiler call. `TypeObject` is the class
 * behind the `Type` interface, so it declares every type method, subtype methods included.
 */
const COMPILER_CLASSES: ReadonlySet<string> = new Set([
  "API",
  "Snapshot",
  "Program",
  "Checker",
  "Printer",
  "Symbol",
  "TypeObject",
  "Signature",
]);

/**
 * Method names of the optimizer's own session and project view. Some match a snapshot or program
 * method, so leaving them in would flag every module that drives a session.
 */
const OPTIMIZER_METHODS: ReadonlySet<string> = new Set([
  "update",
  "close",
  "parse",
  "sourceFile",
  "emit",
  "notifyChanged",
]);

/** Names whose members are compiler calls whatever the member is called. */
const COMPILER_RECEIVERS: ReadonlySet<string> = new Set([
  "checker",
  "program",
  "snapshot",
  "printer",
]);

const COMPILER_MODULE = "compiler.ts";
const PURE_MODULES: ReadonlySet<string> = new Set(["facts.ts", "plan.ts"]);
const COMPILER_ENTRIES: ReadonlySet<string> = new Set(["typescript/async", "typescript/sync"]);

const TSGO = "only compiler.ts reaches tsgo";
const PURE = "facts.ts and plan.ts import nothing from typescript";

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
 * The tokens of `text`, comments and whitespace skipped. A token scan sees no syntax tree, so it
 * tracks template substitutions by brace depth and reads a slash as a regular expression unless the
 * previous token ends an expression.
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

/** Whether `token` is a `from` that `next`, a string, completes. */
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

/** Token kinds that open a class or interface declaration. */
const DECLARATION_KEYWORDS: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.ClassKeyword,
  SyntaxKind.InterfaceKeyword,
]);

/** Token kinds a member name follows in a declaration body: a body start, a member end, or a modifier. */
const MEMBER_STARTS: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.OpenBraceToken,
  SyntaxKind.SemicolonToken,
  SyntaxKind.StaticKeyword,
  SyntaxKind.AbstractKeyword,
  SyntaxKind.OverrideKeyword,
  SyntaxKind.PublicKeyword,
  SyntaxKind.ProtectedKeyword,
]);

/** Token kinds that open a method signature after its name: parameters or type parameters. */
const SIGNATURE_STARTS: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.OpenParenToken,
  SyntaxKind.LessThanToken,
]);

const BRACE_STEPS: ReadonlyMap<SyntaxKind, number> = new Map([
  [SyntaxKind.OpenBraceToken, 1],
  [SyntaxKind.CloseBraceToken, -1],
]);

interface DeclarationBody {
  readonly name: string;
  /** The tokens from the body's `{` to the end of the file. */
  readonly tokens: readonly Token[];
}

/** The kind of `tokens[index]`, or `Unknown` past either end. */
function kindAt(tokens: readonly Token[], index: number): SyntaxKind {
  return tokens[index]?.kind ?? SyntaxKind.Unknown;
}

/** Whether `tokens[index]` names a method in a declaration body, given its neighbors. */
function declaresMethod(tokens: readonly Token[], index: number): boolean {
  return (
    kindAt(tokens, index) === SyntaxKind.Identifier &&
    MEMBER_STARTS.has(kindAt(tokens, index - 1)) &&
    SIGNATURE_STARTS.has(kindAt(tokens, index + 1))
  );
}

/** The bodies of the classes and interfaces `tokens` declare, in source order. */
function declarationBodies(tokens: readonly Token[]): DeclarationBody[] {
  return tokens.flatMap((token, index) => {
    const name = tokens[index + 1];
    if (!DECLARATION_KEYWORDS.has(token.kind) || name?.kind !== SyntaxKind.Identifier) return [];
    const rest = tokens.slice(index);
    const open = rest.findIndex((candidate) => candidate.kind === SyntaxKind.OpenBraceToken);
    return [{ name: name.value, tokens: rest.slice(open) }];
  });
}

/** The methods `body` declares at its own depth, members of nested type literals skipped. */
function bodyMethods(body: DeclarationBody): string[] {
  const methods: string[] = [];
  let depth = 0;
  for (const [index, token] of body.tokens.entries()) {
    depth += BRACE_STEPS.get(token.kind) ?? 0;
    if (depth === 0) break;
    if (depth === 1 && declaresMethod(body.tokens, index)) methods.push(token.value);
  }
  return methods;
}

/** The functions `tokens` declare. */
function declaredFunctions(tokens: readonly Token[]): string[] {
  return tokens.flatMap((token, index) =>
    tokens[index - 1]?.kind === SyntaxKind.FunctionKeyword ? [token.value] : [],
  );
}

const resolver = createRequire(import.meta.url);

/** The declaration files of the package directory holding the module `entry` resolves to. */
function packageDeclarations(entry: string): string[] {
  const dir = dirname(resolver.resolve(entry));
  return readdirSync(dir)
    .filter((name) => name.endsWith(".d.ts"))
    .map((name) => readFileSync(join(dir, name), "utf8"));
}

/** Every method and function name `typescript/ast` declares: calls any module may make on nodes. */
function syntaxNames(): ReadonlySet<string> {
  const tokens = packageDeclarations("typescript/ast").map(tokenize);
  return new Set([
    ...tokens.flatMap((file) => declarationBodies(file).flatMap(bodyMethods)),
    ...tokens.flatMap(declaredFunctions),
  ]);
}

/**
 * Every method of the {@link COMPILER_CLASSES}, read from the `typescript/async` declarations so it
 * follows the installed compiler. Names `typescript/ast` also declares, such as `getSourceFile`, are
 * left out: reading nodes is every module's right, and a program's `getSourceFile` is caught through
 * {@link COMPILER_RECEIVERS} instead. The {@link OPTIMIZER_METHODS} are left out too.
 */
function compilerMethods(): ReadonlySet<string> {
  const entry = resolver.resolve("typescript/async");
  const api = tokenize(readFileSync(entry.replace(/\.js$/u, ".d.ts"), "utf8"));
  const syntax = syntaxNames();
  return new Set(
    declarationBodies(api)
      .filter((body) => COMPILER_CLASSES.has(body.name))
      .flatMap(bodyMethods)
      .filter((name) => !syntax.has(name) && !OPTIMIZER_METHODS.has(name)),
  );
}

const COMPILER_METHODS = compilerMethods();

/** Whether `token`, followed by a token of kind `next`, calls a compiler method. */
function isCompilerCall(token: Token, next: SyntaxKind | undefined): boolean {
  return next === SyntaxKind.OpenParenToken && COMPILER_METHODS.has(token.value);
}

/** Whether `token`, followed by a token of kind `next`, reads a member of a compiler receiver. */
function isCompilerReceiver(token: Token, next: SyntaxKind | undefined): boolean {
  const isMemberAccess = next === SyntaxKind.DotToken || next === SyntaxKind.QuestionDotToken;
  return isMemberAccess && COMPILER_RECEIVERS.has(token.value);
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

/** The identifiers in `tokens` that `matches`, given the kind of the token after each, in source order. */
function scanReferences(
  tokens: readonly Token[],
  matches: (token: Token, next: SyntaxKind | undefined) => boolean,
): Reference[] {
  const references: Reference[] = [];
  for (const [index, token] of tokens.entries()) {
    if (token.kind === SyntaxKind.Identifier && matches(token, tokens[index + 1]?.kind)) {
      references.push({ name: token.value, line: token.line });
    }
  }
  return references;
}

/** The imports, compiler method calls, and compiler receivers `module` spells out. */
function scan(module: Module): ScannedModule {
  const tokens = tokenize(module.text);
  return {
    path: module.path,
    imports: scanImports(tokens, module.path),
    calls: scanReferences(tokens, isCompilerCall),
    receivers: scanReferences(tokens, isCompilerReceiver),
  };
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
export function forbidImports(options: {
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

/** The optimizer's boundaries: only `compiler.ts` reaches tsgo, and the pure modules import no `typescript`. */
export const OPTIMIZER_RULES: readonly Rule[] = [
  requireModules([COMPILER_MODULE, ...PURE_MODULES]),
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
];

/** Every violation of `rules` among `modules`, rule by rule. */
export function checkBoundaries(modules: readonly Module[], rules: readonly Rule[]): string[] {
  const scanned = modules.map(scan);
  return rules.flatMap((rule) => rule(scanned));
}

/** Every TypeScript module under `dir`, test files excluded, in path order. */
export function readModules(dir: string): Module[] {
  return readdirSync(dir, { recursive: true, encoding: "utf8" })
    .filter((rel) => rel.endsWith(".ts") && !rel.endsWith(".test.ts"))
    .toSorted()
    .map((rel) => ({ path: rel.split(sep).join("/"), text: readFileSync(join(dir, rel), "utf8") }));
}
