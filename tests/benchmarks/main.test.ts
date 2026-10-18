import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { pathToFileURL } from "node:url";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { anchoredFilter } from "../../benchmarks/runner.js";
import { packageBin } from "../package-bin.js";
import { createTempDir, REPO_ROOT, removeTempDirs } from "../unit/plugin/tsconfig-fixtures.js";
import {
  COMPILE_FAILURES,
  COMPILE_TIMEOUT_MS,
  OPTIMIZER_CONFIG,
  optimizerConfigProject,
} from "./fixtures.js";

const MAIN = join(REPO_ROOT, "benchmarks", "main.ts");
const TSX = packageBin("tsx", "tsx");
const TSC = packageBin("typescript", "tsc");
const BENCH = "iteration/helper_call";

/**
 * A module preloaded into every Node process the entry starts, through `NODE_OPTIONS`.
 *
 * It appends the process's `argv` and `execArgv` to the file `PROBE_LOG` names, which is how a
 * test sees which compile and which children the entry started, and with which flags. When
 * `PROBE_PROJECT` is set, it also points the optimized compile (the process given `--emit`) at
 * that tsconfig and at `PROBE_OUT_DIR`, after logging the arguments the entry passed. The compile
 * reads its arguments after the preload runs, so a test can fail the entry's real compile without
 * the entry offering any way to choose its project.
 */
const PROBE_SOURCE = `
import { appendFileSync } from "node:fs";

const { PROBE_LOG, PROBE_PROJECT, PROBE_OUT_DIR } = process.env;
appendFileSync(PROBE_LOG, JSON.stringify({ argv: process.argv, execArgv: process.execArgv }) + "\\n");

if (PROBE_PROJECT !== undefined && process.argv.includes("--emit")) {
  process.argv[process.argv.indexOf("-p") + 1] = PROBE_PROJECT;
  process.argv[process.argv.indexOf("--outDir") + 1] = PROBE_OUT_DIR;
}
`;

/** One Node process the entry started, as the probe logged it. */
interface ProcessRecord {
  argv: string[];
  execArgv: string[];
}

/** What a run of the entry printed and which processes it started, in start order. */
interface EntryRun {
  status: number | null;
  stdout: string;
  stderr: string;
  processes: ProcessRecord[];
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

/** Narrows one parsed probe log line to a process record. */
function isProcessRecord(value: unknown): value is ProcessRecord {
  return (
    typeof value === "object" &&
    value !== null &&
    "argv" in value &&
    isStringArray(value.argv) &&
    "execArgv" in value &&
    isStringArray(value.execArgv)
  );
}

/** Parses the probe's log, one JSON process record per line. */
function readProcessLog(log: string): ProcessRecord[] {
  return readFileSync(log, "utf8")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => {
      const record: unknown = JSON.parse(line);
      if (!isProcessRecord(record)) {
        throw new Error(`probe log line is not a process record: ${line}`);
      }
      return record;
    });
}

/**
 * Runs `tsx benchmarks/main.ts` with `args`, the probe preloaded into every Node process it starts.
 *
 * @param args - Command-line arguments for the entry.
 * @param redirect - When given, the tsconfig and output directory the probe points the optimized
 * compile at instead of the ones the entry chose.
 * @returns The entry's exit status and output, and every Node process the run started.
 * @throws Error when the probe or its log cannot be written or read.
 */
function runEntry(
  args: readonly string[],
  redirect?: { project: string; outDir: string },
): EntryRun {
  const dir = createTempDir();
  const probe = join(dir, "probe.mjs");
  const log = join(dir, "processes.jsonl");
  writeFileSync(probe, PROBE_SOURCE);
  writeFileSync(log, "");

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_OPTIONS: `${process.env["NODE_OPTIONS"] ?? ""} --import ${pathToFileURL(probe).href}`,
    PROBE_LOG: log,
  };
  if (redirect !== undefined) {
    env["PROBE_PROJECT"] = redirect.project;
    env["PROBE_OUT_DIR"] = redirect.outDir;
  }

  const result = spawnSync(process.execPath, [TSX, MAIN, ...args], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env,
  });
  if (result.error !== undefined) {
    throw result.error;
  }
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    processes: readProcessLog(log),
  };
}

/** The report a successful run printed, parsed; throws with the run's stderr when it failed. */
function printedReport(run: EntryRun): unknown {
  if (run.status !== 0) {
    throw new Error(`the entry exited with ${String(run.status)}:\n${run.stderr}`);
  }
  return JSON.parse(run.stdout);
}

/** The benchmark children a run started: the processes given `--child`. */
function children(run: EntryRun): ProcessRecord[] {
  return run.processes.filter(({ argv }) => argv.includes("--child"));
}

/** The optimized compiles a run started: the processes given `--emit`. */
function compiles(run: EntryRun): ProcessRecord[] {
  return run.processes.filter(({ argv }) => argv.includes("--emit"));
}

/** The value that follows `flag` in a process's arguments. */
function flagValue(record: ProcessRecord, flag: string): string | undefined {
  const index = record.argv.indexOf(flag);
  return index === -1 ? undefined : record.argv[index + 1];
}

/** The output directory the run's first optimized compile was given. */
function compiledOutDir(run: EntryRun): string {
  const [compile] = compiles(run);
  const outDir = compile === undefined ? undefined : flagValue(compile, "--outDir");
  if (outDir === undefined) {
    throw new Error("the run started no optimized compile with an --outDir");
  }
  return outDir;
}

/**
 * Builds the runtime into `dist/`, which the compiled suite's `import "ecstatic"` resolves to through
 * the package's exports, so a run never measures a build older than the sources.
 */
function buildRuntime(): void {
  const result = spawnSync(process.execPath, [TSC, "-p", "tsconfig.build.json"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(
      `the runtime build exited with ${String(result.status)}:\n${result.stdout}${result.stderr}`,
    );
  }
}

describe("benchmarks/main.ts without --optimized", () => {
  let run: EntryRun;

  beforeAll(() => {
    run = runEntry([anchoredFilter(BENCH)]);
  }, COMPILE_TIMEOUT_MS);

  afterAll(() => {
    removeTempDirs();
  });

  it("prints a report measuring the benchmark under its plain node/ alias", () => {
    const report = printedReport(run);

    expect(report).toMatchObject({
      benchmarks: [{ alias: `node/${BENCH}`, runs: [{ stats: { p50: expect.any(Number) } }] }],
    });
  });

  it("runs the child from the TypeScript entry through tsx without compiling", () => {
    expect({ compiles: compiles(run).length, children: children(run) }).toStrictEqual({
      compiles: 0,
      children: [
        {
          argv: [process.execPath, MAIN, "--child", BENCH],
          execArgv: ["--expose-gc", "--import", "tsx"],
        },
      ],
    });
  });
});

describe("benchmarks/main.ts --optimized", () => {
  let run: EntryRun;

  beforeAll(() => {
    buildRuntime();
    run = runEntry([anchoredFilter(BENCH), "--optimized"]);
  }, COMPILE_TIMEOUT_MS);

  afterAll(() => {
    removeTempDirs();
  });

  it("prints a report measuring the benchmark under its node/optimized/ alias", () => {
    const report = printedReport(run);

    expect(report).toMatchObject({
      benchmarks: [
        { alias: `node/optimized/${BENCH}`, runs: [{ stats: { p50: expect.any(Number) } }] },
      ],
    });
  });

  it("compiles the benchmarks' optimizer config once", () => {
    const projects = compiles(run).map((compile) => flagValue(compile, "-p"));

    expect(projects).toStrictEqual([OPTIMIZER_CONFIG]);
  });

  it("compiles into a directory inside the repository and outside node_modules", () => {
    const fromRoot = relative(REPO_ROOT, compiledOutDir(run));

    expect(fromRoot.startsWith("..") || isAbsolute(fromRoot)).toBe(false);
    expect(fromRoot.split(sep)).not.toContain("node_modules");
  });

  it("compiles into a directory git ignores", () => {
    const compiledMain = join(compiledOutDir(run), "benchmarks", "main.js");

    const checked = spawnSync("git", ["check-ignore", "--quiet", compiledMain], { cwd: REPO_ROOT });

    expect(existsSync(compiledMain)).toBe(true);
    expect(checked.status).toBe(0);
  });

  it("runs the child from the compiled entry with no TypeScript loader", () => {
    const compiledMain = join(compiledOutDir(run), "benchmarks", "main.js");

    expect(children(run)).toStrictEqual([
      { argv: [process.execPath, compiledMain, "--child", BENCH], execArgv: ["--expose-gc"] },
    ]);
  });
});

describe("benchmarks/main.ts --optimized when the compile fails", () => {
  afterEach(() => {
    removeTempDirs();
  });

  it.each(COMPILE_FAILURES)(
    "exits 1 on $label before starting a child, printing the diagnostics on stderr only",
    ({ source, diagnostic }) => {
      const project = optimizerConfigProject(source);

      const failed = runEntry([anchoredFilter(BENCH), "--optimized"], {
        project,
        outDir: join(dirname(project), "out"),
      });

      expect({
        status: failed.status,
        stdout: failed.stdout,
        compiles: compiles(failed).length,
        children: children(failed),
      }).toStrictEqual({ status: 1, stdout: "", compiles: 1, children: [] });
      expect(failed.stderr).toContain(diagnostic);
    },
    COMPILE_TIMEOUT_MS,
  );
});
