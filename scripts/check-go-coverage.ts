import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_PROFILE = "coverage/go.out";
const MINIMUM_PERCENT = 95;

/** `<import path>/<file>.go:<start line>.<col>,<end line>.<col> <statements> <hit count>` */
const BLOCK_LINE = /^(?<file>.+\.go):\d+\.\d+,\d+\.\d+ (?<statements>\d+) (?<count>\d+)$/;

/** A command's entry point: a thin `main` wrapper `go test` cannot run, kept out of the gate. */
const ENTRY_POINT_FILE = "main.go";

/** Statement totals for one Go package. */
interface StatementCount {
  covered: number;
  total: number;
}

function parseProfile(profilePath: string, content: string): Map<string, StatementCount> {
  const [modeLine, ...lines] = content.split(/\r?\n/);
  if (modeLine?.startsWith("mode: ") !== true) {
    throw new Error(`${profilePath} is not a Go coverage profile: the first line is not "mode: …"`);
  }

  const packages = new Map<string, StatementCount>();
  for (const [index, line] of lines.entries()) {
    if (line === "") {
      continue;
    }
    const groups = BLOCK_LINE.exec(line)?.groups;
    const file = groups?.["file"];
    if (groups === undefined || file === undefined) {
      // +1 for the skipped mode line, +1 for 1-based numbering
      throw new Error(`${profilePath}:${index + 2} is not a coverage block: ${line}`);
    }
    addBlock(packages, file, Number(groups["statements"]), Number(groups["count"]));
  }
  return packages;
}

function addBlock(
  packages: Map<string, StatementCount>,
  file: string,
  statements: number,
  count: number,
): void {
  const separator = file.lastIndexOf("/");
  if (file.slice(separator + 1) === ENTRY_POINT_FILE) {
    return;
  }
  const pkg = file.slice(0, separator);
  const totals = packages.get(pkg) ?? { covered: 0, total: 0 };
  totals.total += statements;
  if (count > 0) {
    totals.covered += statements;
  }
  packages.set(pkg, totals);
}

/**
 * Verify that every Go package in a `go test -coverprofile` profile has at least 95% of its
 * statements covered.
 *
 * Statements in files named `main.go` are left out, whatever package they sit in; every other file
 * counts. A package with no counted statements passes.
 *
 * @param profilePath - Path to the coverage profile; the CLI passes its first argument, or
 * `coverage/go.out`.
 * @throws Error naming every package below 95% with its percentage.
 * @throws Error naming the file when it cannot be read, with the filesystem error as its cause.
 * @throws Error naming the file when it is not a coverage profile.
 */
export function checkGoCoverage(profilePath: string): void {
  let content: string;
  try {
    content = readFileSync(profilePath, "utf8");
  } catch (error) {
    throw new Error(`cannot read Go coverage profile ${profilePath} — run: npm run test:go`, {
      cause: error,
    });
  }

  const failing: string[] = [];
  for (const [pkg, { covered, total }] of parseProfile(profilePath, content)) {
    if (total === 0) {
      continue;
    }
    const percent = (covered / total) * 100;
    if (percent < MINIMUM_PERCENT) {
      failing.push(`${pkg}: ${percent.toFixed(1)}% (${covered}/${total} statements)`);
    }
  }

  if (failing.length > 0) {
    failing.sort();
    throw new Error(
      `Go statement coverage is below ${MINIMUM_PERCENT}% in ${profilePath}:\n  ${failing.join("\n  ")}`,
    );
  }
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  checkGoCoverage(process.argv[2] ?? DEFAULT_PROFILE);
}
