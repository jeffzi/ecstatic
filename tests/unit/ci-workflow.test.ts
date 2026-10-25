import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { assert, describe, expect, it } from "vitest";

import { REPO_ROOT } from "./plugin/tsconfig-fixtures.js";

const WORKFLOWS_DIR = join(REPO_ROOT, ".github", "workflows");
const THIS_FILE = "tests/unit/ci-workflow.test.ts";

const ACTIONLINT_ARCHIVE = "actionlint_1.7.12_linux_amd64.tar.gz";
const ACTIONLINT_URL = `https://github.com/rhysd/actionlint/releases/download/v1.7.12/${ACTIONLINT_ARCHIVE}`;
const ACTIONLINT_SHA256 = "8aca8db96f1b94770f1b0d72b6dddcb1ebb8123cb3712530b08cc387b349a3d8";

/**
 * A line that invokes the Go toolchain or its tools, sets it up, names its environment or module
 * files, or uses Go-only vocabulary.
 */
const GO_REMNANT =
  /(?:^|[\s;&|("'`$])go\s+(?:install|env|run|build|mod|get|test|vet|work|generate)\b|setup-go\b|\bgo-?lang|\bgo(?:fmt|imports|lint|pls|routines?)\b|\bGO(?:PATH|ROOT|BIN|FLAGS)\b|(?:^|[\s/"'`])go\.(?:mod|sum|work)\b/iu;

/** A tracked path that only a Go project carries. */
const GO_PATH = /\.go$|(?:^|\/)go\.(?:mod|sum|work)(?:\.sum)?$|(?:^|\/)\.go-?lang[^/]*$/u;

/** The lines of `text`, without line terminators. */
function linesOf(text: string): string[] {
  return text.split(/\r?\n/);
}

/** The leading whitespace of `line`. */
function indentOf(line: string): string {
  return /^(\s*)/.exec(line)?.[1] ?? "";
}

/** The indent of a YAML list item line, or undefined when `line` is not one. */
function itemIndent(line: string): string | undefined {
  return /^(\s*)- /.exec(line)?.[1];
}

/** The lines of `lines` split at each `steps:` key, which is dropped. */
function splitAtStepsKeys(lines: string[]): string[][] {
  let segment: string[] = [];
  const segments = [segment];
  for (const line of lines) {
    if (/^\s*steps:\s*$/.test(line)) {
      segment = [];
      segments.push(segment);
    } else {
      segment.push(line);
    }
  }
  return segments;
}

/** Whether `line` is blank or indented deeper than the list items at `stepIndent`. */
function continuesStep(line: string, stepIndent: string): boolean {
  return line.trim() === "" || indentOf(line).length > stepIndent.length;
}

/** The steps listed in `lines`, the body of one `steps:` key, each as its own lines. */
function collectSteps(lines: string[]): string[][] {
  const steps: string[][] = [];
  const stepIndent = lines.map((line) => itemIndent(line)).find((indent) => indent !== undefined);
  if (stepIndent === undefined) return steps;
  let current: string[] | undefined;
  for (const line of lines) {
    if (itemIndent(line) === stepIndent) {
      current = [line];
      steps.push(current);
    } else if (current !== undefined && continuesStep(line, stepIndent)) {
      current.push(line);
    } else {
      current = undefined;
    }
  }
  return steps;
}

/** The steps of every job in the workflow `text`, each as its own lines. */
function workflowSteps(text: string): string[][] {
  return splitAtStepsKeys(linesOf(text)).flatMap((lines) => collectSteps(lines));
}

/** The lines of the CI step that installs actionlint; fails when there is not exactly one. */
function actionlintStep(): string[] {
  const text = readFileSync(join(WORKFLOWS_DIR, "ci.yml"), "utf8");
  const matching = workflowSteps(text).filter((step) =>
    step.some((line) => line.includes("actionlint")),
  );
  assert(matching.length === 1, `expected one actionlint step, found ${matching.length}`);
  const [step] = matching;
  assert(step !== undefined);
  return step;
}

/** The index of the first line in `lines` that `pattern` matches, or -1. */
function lineIndex(lines: string[], pattern: RegExp): number {
  return lines.findIndex((line) => pattern.test(line));
}

const WORKFLOW_FILES = readdirSync(WORKFLOWS_DIR).filter((name) => /\.ya?ml$/.test(name));

describe("CI workflow", () => {
  describe("actionlint install step", () => {
    it("runs on Linux only, under bash", () => {
      const step = actionlintStep();

      expect(step.map((line) => line.trim())).toStrictEqual(
        expect.arrayContaining(["if: runner.os == 'Linux'", "shell: bash"]),
      );
    });

    it("downloads the pinned v1.7.12 release archive", () => {
      const step = actionlintStep();

      expect(step.join("\n")).toContain(ACTIONLINT_URL);
    });

    it("checks the archive against the release checksum before extracting it", () => {
      const step = actionlintStep();

      const check = lineIndex(step, /\bsha256sum\s+(?:-c|--check)\b/);
      const extract = lineIndex(step, /^\s*tar\s/u);
      expect(check).toBeGreaterThan(-1);
      expect(step[check]).toContain(`${ACTIONLINT_SHA256}  ${ACTIONLINT_ARCHIVE}`);
      // Nothing after the check may swallow its failure, as `|| true` would.
      expect(step[check]).toMatch(/\|\s*sha256sum\s+(?:-c|--check)\s+-\s*$/u);
      expect(extract).toBeGreaterThan(check);
    });

    it("puts the installed tools on PATH for later steps", () => {
      const step = actionlintStep();

      expect(step.join("\n")).toContain('>> "$GITHUB_PATH"');
    });
  });

  it.each(WORKFLOW_FILES)("%s has no step that sets up or runs Go", (name) => {
    const text = readFileSync(join(WORKFLOWS_DIR, name), "utf8");

    const offending = workflowSteps(text)
      .flat()
      .filter((line) => !line.trim().startsWith("#") && GO_REMNANT.test(line))
      .map((line) => line.trim());

    expect(offending).toStrictEqual([]);
  });
});

describe("tracked files", () => {
  it("carry no Go file, Go command, or Go configuration", () => {
    const tracked = execFileSync("git", ["ls-files"], { cwd: REPO_ROOT, encoding: "utf8" })
      .split("\n")
      .filter(
        (path) =>
          path !== "" &&
          path !== THIS_FILE &&
          path !== "package-lock.json" &&
          existsSync(join(REPO_ROOT, path)),
      );

    const goPaths = tracked.filter((path) => GO_PATH.test(path));
    const goLines = tracked.flatMap((path) => {
      const text = readFileSync(join(REPO_ROOT, path), "utf8");
      if (text.includes("\0")) return [];
      return linesOf(text).flatMap((line, index) =>
        GO_REMNANT.test(line) ? [`${path}:${index + 1}`] : [],
      );
    });

    expect({ goPaths, goLines }).toStrictEqual({ goPaths: [], goLines: [] });
  });
});
