import { execFile } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { packageBin } from "../package-bin.js";

const execFileAsync = promisify(execFile);

const ROOT = resolve(import.meta.dirname, "../..");

/** How long one lint run may take on a slow CI runner. */
const LINT_TIMEOUT_MS = 30_000;

/**
 * Modules that each reach for a Node-only facility, keyed by the rule that rejects it, as oxlint
 * reports it (`rule`) and as a suppression comment names it (`directive`).
 */
const NODE_ONLY_MODULES = [
  {
    rule: "eslint(no-restricted-globals)",
    directive: "no-restricted-globals",
    name: "timer.ts",
    source: "export function later(run: () => void): void {\n  setTimeout(run, 0);\n}\n",
  },
  {
    rule: "import(no-nodejs-modules)",
    directive: "import/no-nodejs-modules",
    name: "scratch.ts",
    source: 'import { tmpdir } from "node:os";\n\nexport const scratch: string = tmpdir();\n',
  },
];

interface Diagnostic {
  code: string;
  filename: string;
}

let project = "";
let diagnostics: Diagnostic[] = [];

/** Lints every module under `src/` of `dir` with the repository's oxlint config. */
async function lint(dir: string): Promise<Diagnostic[]> {
  const result = await execFileAsync(
    process.execPath,
    [packageBin("oxlint", "oxlint"), "-c", ".oxlintrc.json", "--format", "json", "src"],
    { cwd: dir },
  ).catch((error: unknown) => {
    if (typeof error === "object" && error !== null && "stdout" in error) {
      return { stdout: String(error.stdout) };
    }
    throw error;
  });
  const report: { diagnostics: Diagnostic[] } = JSON.parse(result.stdout);
  return report.diagnostics;
}

beforeAll(async () => {
  project = mkdtempSync(join(realpathSync(tmpdir()), "ecstatic-lint-"));
  cpSync(join(ROOT, ".oxlintrc.json"), join(project, ".oxlintrc.json"));
  for (const tree of ["ecstatic", "plugin"]) {
    mkdirSync(join(project, "src", tree), { recursive: true });
    for (const { name, source } of NODE_ONLY_MODULES) {
      writeFileSync(join(project, "src", tree, name), source);
    }
  }
  diagnostics = await lint(project);
}, LINT_TIMEOUT_MS);

afterAll(() => {
  rmSync(project, { recursive: true, force: true });
});

/** An oxlint or eslint disable directive, capturing the rule list and reason that follow it. */
const DISABLE_DIRECTIVE = /\b(?:oxlint|eslint)-disable(?:-next-line|-line)?\b(.*)/;

/** Whether `line` holds a disable directive that turns off `directive`, by name or by naming no rule. */
function suppresses(line: string, directive: string): boolean {
  const match = DISABLE_DIRECTIVE.exec(line);
  if (match === null) return false;
  const rules = (match[1] ?? "").split("--")[0]?.replace("*/", "").trim() ?? "";
  return rules === "" || rules.split(/[\s,]+/).includes(directive);
}

/** The rule codes reported against `src/<tree>/<name>`. */
function rulesReported(tree: string, name: string): string[] {
  return diagnostics
    .filter(({ filename }) => filename.split(/[\\/]/).join("/") === `src/${tree}/${name}`)
    .map(({ code }) => code);
}

describe("platform-neutral lint", () => {
  describe("in a runtime module", () => {
    it.each(NODE_ONLY_MODULES)("reports $rule", ({ rule, name }) => {
      const rules = rulesReported("ecstatic", name);

      expect(rules).toContain(rule);
    });
  });

  describe("in a plugin module", () => {
    it.each(NODE_ONLY_MODULES)("does not report $rule", ({ rule, name }) => {
      const rules = rulesReported("plugin", name);

      expect(rules).not.toContain(rule);
    });
  });

  describe("in the plugin's own sources", () => {
    it.each(NODE_ONLY_MODULES)("no comment suppresses $directive", ({ directive }) => {
      const pluginDir = join(ROOT, "src", "plugin");
      const sources = readdirSync(pluginDir, { recursive: true, encoding: "utf8" })
        .filter((rel) => rel.endsWith(".ts"))
        .map((rel) => ({ rel, text: readFileSync(join(pluginDir, rel), "utf8") }));

      const suppressing = sources
        .filter(({ text }) => text.split(/\r?\n/).some((line) => suppresses(line, directive)))
        .map(({ rel }) => rel);

      expect(suppressing).toStrictEqual([]);
    });
  });
});
