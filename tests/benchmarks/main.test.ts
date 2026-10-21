import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { anchoredFilter } from "../../benchmarks/runner.js";
import { packageBin } from "../package-bin.js";
import { ROW_LOOP } from "../unit/optimizer/printed.js";
import { createProject, REPO_ROOT, removeTempDirs } from "../unit/plugin/tsconfig-fixtures.js";
import {
  benchmarkTreeWith,
  COMPILE_FAILURES,
  COMPILE_TIMEOUT_MS,
  removeBenchmarkProjects,
} from "./fixtures.js";
import { requiresRealBun } from "./real-bun.js";

const MAIN = join(REPO_ROOT, "benchmarks", "main.ts");
const TSX = packageBin("tsx", "tsx");
const TSC = packageBin("typescript", "tsc");

/** The directory the `--optimized` mode compiles the benchmark sources into. */
const OUT_DIR = join(REPO_ROOT, ".bench-optimized");
const COMPILED_MAIN = join(OUT_DIR, "benchmarks", "main.js");

/** Two benchmarks, so a run starts two children from one compile. */
const BENCHES = ["iteration/helper_call", "iteration/throughput"] as const;
const BENCHES_FILTER = "^iteration/(helper_call|throughput)$";
const BENCH = "iteration/helper_call";
/**
 * Whether to start real Bun children: wherever Bun is installed, and always on CI, which installs it,
 * so a CI runner without Bun fails the case instead of skipping it.
 */
const RUN_UNDER_BUN = requiresRealBun(
  spawnSync("bun", ["--version"]).status === 0,
  process.env["CI"],
);
/** Both engines, so an optimized run shows it compiles once per run, not once per engine. */
const ENGINES = ["node", "bun"] as const;

/** Every call of `each` with arguments, so a comment naming `each()` does not match. */
const EACH_CALLS = /\beach\((?!\))/gu;

/** The message every output write the probe refuses fails with. */
const REFUSED_WRITE = "EACCES: permission denied";

/**
 * A module preloaded into every Node process the entry starts, through `NODE_OPTIONS`.
 *
 * It appends the process's `argv` and `execArgv` to the file `PROBE_LOG` names, which is how a test
 * sees which children the entry started, and with which flags. It also wraps `node:fs`'s file
 * writes: a write under `PROBE_OUT_DIR` is appended to the file `PROBE_WRITES` names, and when
 * `PROBE_REFUSE_WRITES` is set, it fails instead, as a write to a read-only directory does. Every
 * process the process spawns is appended to the file `PROBE_SPAWNS` names; a spawn of `bun` runs Node
 * instead, so a run under both engines needs no Bun install, unless `PROBE_REAL_BUN` is set.
 */
const PROBE_SOURCE = `
import childProcess from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { fileURLToPath } from "node:url";

const { appendFileSync } = fs;
const { PROBE_LOG, PROBE_WRITES, PROBE_SPAWNS, PROBE_OUT_DIR, PROBE_REFUSE_WRITES, PROBE_REAL_BUN } =
  process.env;
appendFileSync(PROBE_LOG, JSON.stringify({ argv: process.argv, execArgv: process.execArgv }) + "\\n");

function refusal(file) {
  const path = file instanceof URL ? fileURLToPath(file) : String(file);
  if (!path.startsWith(PROBE_OUT_DIR)) return undefined;
  appendFileSync(PROBE_WRITES, path + "\\n");
  if (PROBE_REFUSE_WRITES === undefined) return undefined;
  return Object.assign(new Error("${REFUSED_WRITE}, open '" + path + "'"), { code: "EACCES" });
}

const { writeFileSync, writeFile } = fs;
const writeFilePromise = fs.promises.writeFile;
fs.writeFileSync = (file, ...rest) => {
  const error = refusal(file);
  if (error !== undefined) throw error;
  return writeFileSync(file, ...rest);
};
fs.writeFile = (file, ...rest) => {
  const error = refusal(file);
  if (error !== undefined) return process.nextTick(rest.at(-1), error);
  return writeFile(file, ...rest);
};
fs.promises.writeFile = async (file, ...rest) => {
  const error = refusal(file);
  if (error !== undefined) throw error;
  return writeFilePromise(file, ...rest);
};
const { spawn } = childProcess;
childProcess.spawn = (command, args, ...rest) => {
  appendFileSync(PROBE_SPAWNS, JSON.stringify({ command, args: Array.isArray(args) ? args : [] }) + "\\n");
  const runsNode = command === "bun" && PROBE_REAL_BUN === undefined;
  return spawn(runsNode ? process.execPath : command, args, ...rest);
};
syncBuiltinESMExports();
`;

/** One Node process the entry started, as the probe logged it. */
interface ProcessRecord {
  argv: string[];
  execArgv: string[];
}

/** One process a Node process spawned, as the probe logged it. */
interface SpawnRecord {
  command: string;
  args: string[];
}

/** What a run of the entry printed, which processes it started and spawned, and which outputs it wrote. */
interface EntryRun {
  status: number | null;
  stdout: string;
  stderr: string;
  processes: ProcessRecord[];
  spawns: SpawnRecord[];
  writes: string[];
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

/** Narrows one parsed probe spawn line to a spawn record. */
function isSpawnRecord(value: unknown): value is SpawnRecord {
  return (
    typeof value === "object" &&
    value !== null &&
    "command" in value &&
    typeof value.command === "string" &&
    "args" in value &&
    isStringArray(value.args)
  );
}

/** The non-empty lines of `file`. */
function readLines(file: string): string[] {
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line !== "");
}

/** Parses the probe's log, one JSON process record per line. */
function readProcessLog(log: string): ProcessRecord[] {
  return readLines(log).map((line) => {
    const record: unknown = JSON.parse(line);
    if (!isProcessRecord(record)) {
      throw new Error(`probe log line is not a process record: ${line}`);
    }
    return record;
  });
}

/** Parses the probe's spawn log, one JSON spawn record per line. */
function readSpawnLog(log: string): SpawnRecord[] {
  return readLines(log).map((line) => {
    const record: unknown = JSON.parse(line);
    if (!isSpawnRecord(record)) {
      throw new Error(`probe spawn line is not a spawn record: ${line}`);
    }
    return record;
  });
}

/**
 * Runs `tsx benchmarks/main.ts` with `args`, the probe preloaded into every Node process it starts.
 *
 * @param args - Command-line arguments for the entry.
 * @param options - `refuseWrites` makes every write under the output directory fail; `entry` runs
 * another copy of `benchmarks/main.ts`; `realBun` lets a spawn of `bun` run Bun instead of Node.
 * @returns The entry's exit status and output, every Node process the run started, every process
 * those spawned, and every write under the output directory.
 * @throws Error when the probe or its logs cannot be written or read.
 */
function runEntry(
  args: readonly string[],
  options: { refuseWrites?: boolean; entry?: string; realBun?: boolean } = {},
): EntryRun {
  const dir = createProject({
    "probe.mjs": PROBE_SOURCE,
    "processes.jsonl": "",
    "spawns.jsonl": "",
    "writes.log": "",
  });
  const log = join(dir, "processes.jsonl");
  const spawns = join(dir, "spawns.jsonl");
  const writes = join(dir, "writes.log");

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_OPTIONS: `${process.env["NODE_OPTIONS"] ?? ""} --import ${pathToFileURL(join(dir, "probe.mjs")).href}`,
    PROBE_LOG: log,
    PROBE_WRITES: writes,
    PROBE_SPAWNS: spawns,
    PROBE_OUT_DIR: OUT_DIR,
  };
  if (options.refuseWrites === true) {
    env["PROBE_REFUSE_WRITES"] = "1";
  }
  if (options.realBun === true) {
    env["PROBE_REAL_BUN"] = "1";
  }

  const result = spawnSync(process.execPath, [TSX, options.entry ?? MAIN, ...args], {
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
    spawns: readSpawnLog(spawns),
    writes: readLines(writes),
  };
}

/** The report a successful run printed, parsed; throws with the run's stderr when it failed. */
function printedReport(run: EntryRun): unknown {
  if (run.status !== 0) {
    throw new Error(`the entry exited with ${String(run.status)}:\n${run.stderr}`);
  }
  return JSON.parse(run.stdout);
}

/** The benchmark children a run started, ordered by benchmark name: the processes given `--child`. */
function children(run: EntryRun): ProcessRecord[] {
  return run.processes
    .filter(({ argv }) => argv.includes("--child"))
    .toSorted((a, b) => (a.argv.at(-1) ?? "").localeCompare(b.argv.at(-1) ?? ""));
}

/** Orders spawns by engine command, then by benchmark name. */
function bySpawn(a: SpawnRecord, b: SpawnRecord): number {
  const key = ({ command, args }: SpawnRecord): string => `${command} ${args.at(-1) ?? ""}`;
  return key(a).localeCompare(key(b));
}

/** The benchmark children a run spawned, in {@link bySpawn} order. */
function childSpawns(run: EntryRun): SpawnRecord[] {
  return run.spawns.filter(({ args }) => args.includes("--child")).toSorted(bySpawn);
}

/** The compiler processes a run spawned: the TypeScript API starts each with `--api` first. */
function compilerSpawns(run: EntryRun): SpawnRecord[] {
  return run.spawns.filter(({ args }) => args[0] === "--api");
}

/** The text of the compiled output of the benchmark source `name`; throws when `run` did not write it. */
function compiled(run: EntryRun, name: string): string {
  const file = join(OUT_DIR, "benchmarks", name);
  if (!run.writes.includes(file)) {
    throw new Error(`the run did not write ${file}`);
  }
  return readFileSync(file, "utf8");
}

/** The index of the bracket that closes the `pair[0]` at `open` in `text`, or -1 when none does. */
function closingBracket(text: string, open: number, pair: "()" | "{}"): number {
  let depth = 0;
  for (let index = open; index < text.length; index++) {
    if (text[index] === pair[0]) depth++;
    if (text[index] === pair[1]) depth--;
    if (depth === 0) return index;
  }
  return -1;
}

/** The index of the helper_call benchmark's `= advance(` call in `text`. */
function advanceCall(text: string): number {
  const call = /=\s*advance\(/u.exec(text);
  if (call === null) throw new Error("the compiled iteration benchmarks hold no advance call");
  return call.index;
}

/** Whether `index` in `text` sits inside the arguments of the nearest `each(` call before it. */
function insideEachCall(text: string, index: number): boolean {
  const each = text.lastIndexOf("each(", index);
  return each !== -1 && closingBracket(text, each + "each".length, "()") > index;
}

/** Whether `index` in `text` sits inside the body of the nearest row loop before it. */
function insideRowLoop(text: string, index: number): boolean {
  const loop = text.lastIndexOf(ROW_LOOP, index);
  if (loop === -1) return false;
  const header = closingBracket(text, loop + "for ".length, "()");
  const body = text.indexOf("{", header);
  return body !== -1 && closingBracket(text, body, "{}") > index;
}

/** How many `each` calls and row loops `text` holds. */
function loopCounts(text: string): { eachCalls: number; rowLoops: number } {
  return {
    eachCalls: text.match(EACH_CALLS)?.length ?? 0,
    rowLoops: text.split(ROW_LOOP).length - 1,
  };
}

/** The `ecstatic` package specifiers `text` imports from, sorted. */
function ecstaticImports(text: string): string[] {
  const specifiers = Array.from(
    text.matchAll(/from\s+"(ecstatic(?:\/[^"]*)?)"/gu),
    (match) => match[1] ?? "",
  );
  return [...new Set(specifiers)].toSorted((a, b) => a.localeCompare(b));
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
    expect({
      writes: run.writes,
      compilerSpawns: compilerSpawns(run),
      children: children(run),
    }).toStrictEqual({
      writes: [],
      compilerSpawns: [],
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
    run = runEntry([BENCHES_FILTER, "--engine", "node,bun", "--optimized"]);
  }, COMPILE_TIMEOUT_MS);

  afterAll(() => {
    removeTempDirs();
  });

  it("prints a report measuring each benchmark under each engine's optimized/ alias", () => {
    const report = printedReport(run);

    expect(report).toMatchObject({
      benchmarks: expect.arrayContaining(
        ENGINES.flatMap((engine) => BENCHES.map((bench) => `${engine}/optimized/${bench}`)).map(
          (alias) =>
            expect.objectContaining({
              alias,
              runs: [
                expect.objectContaining({
                  stats: expect.objectContaining({ p50: expect.any(Number) }),
                }),
              ],
            }),
        ),
      ),
    });
  });

  it("compiles once, then runs every child from the compiled entry with no TypeScript loader", () => {
    const compiledMainWrites = run.writes.filter((file) => file === COMPILED_MAIN);

    expect({
      compiledMainWrites,
      compilers: compilerSpawns(run).length,
      childSpawns: childSpawns(run),
    }).toStrictEqual({
      compiledMainWrites: [COMPILED_MAIN],
      compilers: 1,
      // Node's path sorts before `bun` on POSIX, where it starts with `/`, and after it on Windows.
      childSpawns: [process.execPath, "bun"]
        .flatMap((command) =>
          BENCHES.map((bench) => ({
            command,
            args: ["--expose-gc", COMPILED_MAIN, "--child", bench],
          })),
        )
        .toSorted(bySpawn),
    });
  });

  it("compiles into a directory git ignores", () => {
    const checked = spawnSync("git", ["check-ignore", "--quiet", COMPILED_MAIN], {
      cwd: REPO_ROOT,
    });

    expect(checked.status).toBe(0);
  });

  it("compiles every each call of the systems to a row loop", () => {
    const source = loopCounts(readFileSync(join(REPO_ROOT, "benchmarks", "systems.ts"), "utf8"));

    const output = loopCounts(compiled(run, "systems.js"));

    expect(output).toStrictEqual({ eachCalls: 0, rowLoops: source.rowLoops + source.eachCalls });
  });

  it("compiles the each call of the helper_call benchmark to a row loop", () => {
    const text = compiled(run, "iteration-bench.js");
    const call = advanceCall(text);

    expect({
      insideEachCall: insideEachCall(text, call),
      insideRowLoop: insideRowLoop(text, call),
    }).toStrictEqual({
      insideEachCall: false,
      insideRowLoop: true,
    });
  });

  it.each(["iteration-bench.js", "systems.js"])(
    "keeps the imports of %s on the ecstatic package",
    (name) => {
      expect(ecstaticImports(compiled(run, name))).toStrictEqual(["ecstatic", "ecstatic/internal"]);
    },
  );

  it("resolves the compiled imports to the runtime built in dist", () => {
    const resolveFromOutput = createRequire(
      join(OUT_DIR, "benchmarks", "iteration-bench.js"),
    ).resolve;

    const resolved = ["ecstatic", "ecstatic/internal"].map((specifier) =>
      resolveFromOutput(specifier),
    );

    expect(resolved).toStrictEqual([
      join(REPO_ROOT, "dist", "index.js"),
      join(REPO_ROOT, "dist", "internal.js"),
    ]);
  });
});

describe.runIf(RUN_UNDER_BUN)("benchmarks/main.ts --optimized under Bun", () => {
  let run: EntryRun;

  beforeAll(() => {
    buildRuntime();
    run = runEntry([anchoredFilter(BENCH), "--engine", "bun", "--optimized"], { realBun: true });
  }, COMPILE_TIMEOUT_MS);

  afterAll(() => {
    removeTempDirs();
  });

  it("measures the benchmark in a Bun child running the compiled entry", () => {
    const report = printedReport(run);

    expect({ report, childSpawns: childSpawns(run) }).toMatchObject({
      report: {
        benchmarks: [
          { alias: `bun/optimized/${BENCH}`, runs: [{ stats: { p50: expect.any(Number) } }] },
        ],
      },
      childSpawns: [{ command: "bun", args: ["--expose-gc", COMPILED_MAIN, "--child", BENCH] }],
    });
  });
});

describe.each(COMPILE_FAILURES)(
  "benchmarks/main.ts --optimized on a benchmark source with $label",
  ({ source, diagnostic }) => {
    let run: EntryRun;

    beforeAll(() => {
      buildRuntime();
      run = runEntry([anchoredFilter(BENCH), "--optimized"], { entry: benchmarkTreeWith(source) });
    }, COMPILE_TIMEOUT_MS);

    afterAll(() => {
      removeBenchmarkProjects();
      removeTempDirs();
    });

    it("exits 1 before starting a child, printing the cause on stderr only", () => {
      expect({
        status: run.status,
        stdout: run.stdout,
        childSpawns: childSpawns(run),
      }).toStrictEqual({
        status: 1,
        stdout: "",
        childSpawns: [],
      });
      expect(run.stderr).toContain(diagnostic);
    });
  },
);

describe("benchmarks/main.ts with a repeated --optimized", () => {
  afterEach(() => {
    removeTempDirs();
  });

  it(
    "exits 2 without compiling, printing the usage error on stderr only",
    () => {
      const failed = runEntry(["--optimized", "--optimized"]);

      expect({
        status: failed.status,
        stdout: failed.stdout,
        writes: failed.writes,
        compilerSpawns: compilerSpawns(failed),
      }).toStrictEqual({ status: 2, stdout: "", writes: [], compilerSpawns: [] });
      expect(failed.stderr).toContain("--optimized may only appear once");
    },
    COMPILE_TIMEOUT_MS,
  );
});

describe("benchmarks/main.ts --optimized when an output cannot be written", () => {
  afterEach(() => {
    removeTempDirs();
  });

  it(
    "exits 1 before starting a child, printing the cause on stderr only",
    () => {
      const failed = runEntry([anchoredFilter(BENCH), "--optimized"], { refuseWrites: true });

      expect({
        status: failed.status,
        stdout: failed.stdout,
        children: children(failed),
      }).toStrictEqual({ status: 1, stdout: "", children: [] });
      expect(failed.stderr).toContain(REFUSED_WRITE);
    },
    COMPILE_TIMEOUT_MS,
  );
});
