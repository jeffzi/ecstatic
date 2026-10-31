import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { cpus } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { afterAll, beforeAll, describe, expect, it, onTestFinished, vi } from "vitest";

import { packageBin } from "../package-bin.js";
import { ROW_LOOP } from "../unit/optimizer/printed.js";
import {
  createProject,
  removeTempDirs,
  REPO_ROOT,
  withTempProject,
} from "../unit/plugin/tsconfig-fixtures.js";
import {
  advanceCall,
  benchmarkTreeWith,
  COMPILE_FAILURES,
  COMPILE_TIMEOUT_MS,
  removeBenchmarkProjects,
} from "./fixtures.js";
import { realBunRequired } from "./real-bun.js";

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
const BENCH_FILTER = "^iteration/helper_call$";
/**
 * Whether to start real Bun children: wherever Bun is installed, and always on CI, which installs it,
 * so a CI runner without Bun fails the case instead of skipping it.
 */
const RUN_UNDER_BUN = realBunRequired();
/** Both engines, so an optimized run shows it compiles once per run, not once per engine. */
const ENGINES = ["node", "bun"] as const;

/** Every call of `each` with arguments, so a comment naming `each()` does not match. */
const EACH_CALLS = /\beach\((?!\))/gu;

/** The status a child the probe fails exits with. */
const FAILED_CHILD_EXIT = 3;

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
 * instead, so a run under both engines needs no Bun install, unless `PROBE_REAL_BUN` is set. A child
 * given `--child` with the benchmark `PROBE_FAIL_CHILD` names exits with {@link FAILED_CHILD_EXIT}
 * before measuring anything; one given the benchmark `PROBE_HANG_CHILD` names writes its pid to
 * the file `PROBE_HANG_PID` names, then blocks until a signal kills it.
 */
const PROBE_SOURCE = `
import childProcess from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { fileURLToPath } from "node:url";

const { appendFileSync } = fs;
const {
  PROBE_LOG,
  PROBE_WRITES,
  PROBE_SPAWNS,
  PROBE_OUT_DIR,
  PROBE_REFUSE_WRITES,
  PROBE_REAL_BUN,
  PROBE_FAIL_CHILD,
  PROBE_HANG_CHILD,
  PROBE_HANG_PID,
} = process.env;
appendFileSync(PROBE_LOG, JSON.stringify({ argv: process.argv, execArgv: process.execArgv }) + "\\n");
if (process.argv.includes("--child") && process.argv.at(-1) === PROBE_FAIL_CHILD) {
  process.exit(${String(FAILED_CHILD_EXIT)});
}
if (process.argv.includes("--child") && process.argv.at(-1) === PROBE_HANG_CHILD) {
  appendFileSync(PROBE_HANG_PID, String(process.pid));
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
}

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

/** Narrows a value to an array of strings. */
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

/** Parses a probe log, one JSON record per line, failing with `rejection` on a line `isRecord` refuses. */
function readRecords<T>(
  log: string,
  isRecord: (value: unknown) => value is T,
  rejection: string,
): T[] {
  return readLines(log).map((line) => {
    const record: unknown = JSON.parse(line);
    if (!isRecord(record)) {
      throw new Error(`${rejection}: ${line}`);
    }
    return record;
  });
}

/**
 * Runs `tsx benchmarks/main.ts` with `args`, the probe preloaded into every Node process it starts.
 *
 * @param args - Command-line arguments for the entry.
 * @param options - `refuseWrites` makes every write under the output directory fail; `entry` runs
 * another copy of `benchmarks/main.ts`; `realBun` lets a spawn of `bun` run Bun instead of Node;
 * `failChild` makes the child that measures that benchmark fail.
 * @returns The entry's exit status and output, every Node process the run started, every process
 * those spawned, and every write under the output directory.
 * @throws Error when the probe or its logs cannot be written or read.
 */
function runEntry(
  args: readonly string[],
  options: { refuseWrites?: boolean; entry?: string; realBun?: boolean; failChild?: string } = {},
): EntryRun {
  const probeFiles = {
    "probe.mjs": PROBE_SOURCE,
    "processes.jsonl": "",
    "spawns.jsonl": "",
    "writes.log": "",
  };
  return withTempProject(probeFiles, (dir) => {
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
    if (options.failChild !== undefined) {
      env["PROBE_FAIL_CHILD"] = options.failChild;
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
      processes: readRecords(log, isProcessRecord, "probe log line is not a process record"),
      spawns: readRecords(spawns, isSpawnRecord, "probe spawn line is not a spawn record"),
      writes: readLines(writes),
    };
  });
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
    run = runEntry([BENCH_FILTER]);
  }, COMPILE_TIMEOUT_MS);

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

describe("benchmarks/main.ts when a child fails", () => {
  /** The first of {@link BENCHES} in registration order, so the other would run after it. */
  const FAILING = "iteration/throughput";
  let run: EntryRun;

  beforeAll(() => {
    run = runEntry([BENCHES_FILTER], { failChild: FAILING });
  }, COMPILE_TIMEOUT_MS);

  it("exits 1 before starting another child, printing no report", () => {
    expect({
      status: run.status,
      stdout: run.stdout,
      started: children(run).map(({ argv }) => argv.at(-1)),
    }).toStrictEqual({ status: 1, stdout: "", started: [FAILING] });
  });

  it("names the failed child's command and exit status on stderr", () => {
    expect(run.stderr).toContain(
      `--child ${FAILING} failed with exit code ${String(FAILED_CHILD_EXIT)}`,
    );
  });
});

/** Whether the process `pid` still exists. */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("benchmarks/main.ts when interrupted", () => {
  afterAll(() => {
    removeTempDirs();
  });

  it.each(["SIGINT", "SIGTERM"] as const)(
    "exits 1 on %s after taking down the child measuring",
    async (signal) => {
      const dir = createProject({ "probe.mjs": PROBE_SOURCE, "child.pid": "" });
      const childPid = join(dir, "child.pid");
      const parent = spawn(process.execPath, [TSX, MAIN, BENCH_FILTER], {
        cwd: REPO_ROOT,
        stdio: "ignore",
        env: {
          ...process.env,
          NODE_OPTIONS: `${process.env["NODE_OPTIONS"] ?? ""} --import ${pathToFileURL(join(dir, "probe.mjs")).href}`,
          PROBE_LOG: join(dir, "processes.jsonl"),
          PROBE_WRITES: join(dir, "writes.log"),
          PROBE_SPAWNS: join(dir, "spawns.jsonl"),
          PROBE_OUT_DIR: OUT_DIR,
          PROBE_HANG_CHILD: BENCH,
          PROBE_HANG_PID: childPid,
        },
      });
      const exited = once(parent, "exit");
      await vi.waitFor(
        () => {
          expect(readFileSync(childPid, "utf8")).not.toBe("");
        },
        { timeout: COMPILE_TIMEOUT_MS, interval: 50 },
      );
      const pid = Number(readFileSync(childPid, "utf8"));
      // The hung child blocks until a signal kills it; when the parent fails to, kill it here so a
      // regression fails this case without leaving a process behind.
      onTestFinished(() => {
        if (isAlive(pid)) process.kill(pid, "SIGKILL");
      });

      parent.kill(signal);
      const [status] = await exited;

      expect(status).toBe(1);
      await vi.waitFor(
        () => {
          expect(isAlive(pid)).toBe(false);
        },
        { timeout: 5000, interval: 50 },
      );
    },
    COMPILE_TIMEOUT_MS,
  );
});

/** A benchmark whose body adds to its suite's sink, so a run leaves that sink non-zero. */
const SINKING_BENCH = "access/get_1field";

/** The benchmark the child probe registers with a body that throws {@link THROWN}. */
const THROWING_BENCH = "banana/throws";
const THROWN = "banana peel";

/**
 * The benchmark the child probe registers with a body that busy-waits 0.1 ms on three calls in
 * four and 2 ms on the fourth, so its median sample is near 100 000 ns and its mean near 575 000 ns.
 */
const TIMED_BENCH = "banana/waits";

/** The suites that export a `sinkValue()`, as the child probe imports them. */
const SINK_SUITES = ["access-bench.ts", "entity-bench.ts", "iteration-bench.ts", "many-bench.ts"];

/**
 * For each of {@link SINK_SUITES} after the first, in order, a benchmark whose body adds to that
 * suite's sink. The first suite's benchmark is {@link SINKING_BENCH}, which the `--child` suite
 * already runs.
 */
const SINKING_BENCHES = [
  "entity/alive_check",
  "iteration/each_with_despawn",
  "many/spawn_empty",
] as const;

/** One child starting tsx, then measuring a benchmark for its 1.25 s of warmup and timing, on a slow CI runner. */
const CHILD_TIMEOUT_MS = 60_000;

/**
 * A module preloaded into a child after tsx, through `--import`.
 *
 * It imports every suite that exports a `sinkValue()`; on exit it writes to the file
 * `CHILD_PROBE_SINK` names what the run stored in `globalThis.benchSink` and each suite's sink
 * value. When `CHILD_PROBE_THROWING` is set, it first registers a benchmark under that name whose
 * body throws; when `CHILD_PROBE_TIMED` is set, one under that name whose body waits as
 * {@link TIMED_BENCH} says. When `CHILD_PROBE_PRIME` is set, it measures the benchmark it names
 * before the child starts, so that benchmark's suite's sink is non-zero too.
 */
const CHILD_PROBE_SOURCE = `
import { writeFileSync } from "node:fs";

const base = ${JSON.stringify(pathToFileURL(join(REPO_ROOT, "benchmarks")).href)} + "/";
const { CHILD_PROBE_SINK, CHILD_PROBE_THROWING, CHILD_PROBE_TIMED, CHILD_PROBE_PRIME } = process.env;
const suites = await Promise.all(${JSON.stringify(SINK_SUITES)}.map((file) => import(base + file)));
const { measureBench, registerBench } = await import(base + "runner.ts");
const { makeThroughputWorld, warmedBench } = await import(base + "helpers.ts");
if (CHILD_PROBE_THROWING !== undefined) {
  registerBench(
    CHILD_PROBE_THROWING,
    warmedBench(makeThroughputWorld, () => {
      throw new Error(${JSON.stringify(THROWN)});
    }),
  );
}
if (CHILD_PROBE_TIMED !== undefined) {
  let calls = 0;
  registerBench(
    CHILD_PROBE_TIMED,
    warmedBench(makeThroughputWorld, () => {
      calls += 1;
      const waitMs = calls % 4 === 0 ? 2 : 0.1;
      const started = performance.now();
      while (performance.now() - started < waitMs);
    }),
  );
}
if (CHILD_PROBE_PRIME !== undefined) {
  await measureBench(CHILD_PROBE_PRIME);
}
process.on("exit", () => {
  const sinks = suites.map((suite) => suite.sinkValue());
  writeFileSync(CHILD_PROBE_SINK, JSON.stringify({ stored: globalThis.benchSink, sinks }));
});
`;

/** What a child printed and the sink its probe read on exit. */
interface ChildRun {
  status: number | null;
  stdout: string;
  stderr: string;
  sink: unknown;
}

/**
 * Runs `benchmarks/main.ts --child benchName` as the parent spawns it under Node, the child probe
 * preloaded after tsx.
 *
 * @param benchName - The benchmark the child measures.
 * @param options - `exposeGc: false` leaves out `--expose-gc`; `throwing` has the probe register
 * {@link THROWING_BENCH}, and `timed` {@link TIMED_BENCH}; `prime` names a benchmark the probe
 * measures before the child starts.
 * @returns The child's exit status and output, and the sink its probe wrote on exit.
 * @throws Error when the child cannot be started or the probe's files cannot be written or read.
 */
function runChild(
  benchName: string,
  options: { exposeGc?: boolean; throwing?: boolean; timed?: boolean; prime?: string } = {},
): ChildRun {
  return withTempProject({ "probe.mjs": CHILD_PROBE_SOURCE, "sink.json": "" }, (dir) => {
    const sinkFile = join(dir, "sink.json");
    const env: NodeJS.ProcessEnv = { ...process.env, CHILD_PROBE_SINK: sinkFile };
    if (options.throwing === true) {
      env["CHILD_PROBE_THROWING"] = THROWING_BENCH;
    }
    if (options.timed === true) {
      env["CHILD_PROBE_TIMED"] = TIMED_BENCH;
    }
    if (options.prime !== undefined) {
      env["CHILD_PROBE_PRIME"] = options.prime;
    }
    const flags = options.exposeGc === false ? [] : ["--expose-gc"];
    const probe = pathToFileURL(join(dir, "probe.mjs")).href;

    const result = spawnSync(
      process.execPath,
      [...flags, "--import", "tsx", "--import", probe, MAIN, "--child", benchName],
      { cwd: REPO_ROOT, encoding: "utf8", env },
    );
    if (result.error !== undefined) {
      throw result.error;
    }
    const written = readFileSync(sinkFile, "utf8");
    return {
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
      sink: written === "" ? undefined : JSON.parse(written),
    };
  });
}

/** The statistics a child reports, from the lowest-ranked to the highest. */
const RANKS = ["min", "p25", "p50", "p75", "p99", "max"];

/** The `key` property of `value`, or undefined when `value` is not an object. */
function field(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined;
}

/** The stats object of the first run of the first benchmark in a child's report. */
function reportedStats(stdout: string): unknown {
  const report: unknown = JSON.parse(stdout);
  return ["benchmarks", "0", "runs", "0", "stats"].reduce(field, report);
}

/**
 * Asserts the child stored the sink of suite `suite` alone, with that sink and the primed suite's
 * sink both non-zero, so storing another suite's sink or the sum of every sink fails.
 */
function expectSinkStored(sink: unknown, suite: number, primed: number): void {
  const sinks = field(sink, "sinks");
  const values = Array.isArray(sinks) ? sinks.map(Number) : [];
  expect({
    stored: field(sink, "stored"),
    ownSinkNonZero: values[suite] !== 0,
    primedSinkNonZero: values[primed] !== 0,
  }).toStrictEqual({
    stored: values[suite],
    ownSinkNonZero: true,
    primedSinkNonZero: true,
  });
}

describe("benchmarks/main.ts --child", () => {
  let run: ChildRun;

  beforeAll(() => {
    run = runChild(SINKING_BENCH, { prime: SINKING_BENCHES[0] });
  }, CHILD_TIMEOUT_MS);

  it("prints one JSON report of the benchmark's statistics under its plain name, and nothing else", () => {
    const report: unknown = JSON.parse(run.stdout);

    expect({ status: run.status, report }).toStrictEqual({
      status: 0,
      report: {
        layout: [{ name: 0, types: [] }],
        context: {
          runtime: "node",
          version: process.versions.node,
          arch: `${process.arch}-${process.platform}`,
          cpu: { name: cpus()[0]?.model },
        },
        benchmarks: [
          {
            alias: SINKING_BENCH,
            runs: [
              {
                stats: {
                  min: expect.any(Number),
                  p25: expect.any(Number),
                  p50: expect.any(Number),
                  p75: expect.any(Number),
                  p99: expect.any(Number),
                  max: expect.any(Number),
                  avg: expect.any(Number),
                  samples: expect.any(Number),
                },
              },
            ],
          },
        ],
      },
    });
  });

  it("reports the statistics under the names of their rank, from min to max", () => {
    const stats = reportedStats(run.stdout);

    const ranked = RANKS.map((rank) => Number(field(stats, rank)));

    expect(ranked).toStrictEqual(ranked.toSorted((a, b) => a - b));
  });

  it("stores its own suite's sink value in globalThis.benchSink", () => {
    expectSinkStored(run.sink, SINK_SUITES.indexOf("access-bench.ts"), 1);
  });
});

describe.each(SINKING_BENCHES.map((bench, index) => ({ bench, suite: index + 1 })))(
  "benchmarks/main.ts --child $bench",
  ({ bench, suite }) => {
    it(
      "stores its own suite's sink value in globalThis.benchSink",
      () => {
        const { sink } = runChild(bench, { prime: SINKING_BENCH });

        expectSinkStored(sink, suite, 0);
      },
      CHILD_TIMEOUT_MS,
    );
  },
);

describe("benchmarks/main.ts --child reporting a body's times", () => {
  it(
    "reports nanoseconds per call, with avg the mean of the samples",
    () => {
      const { stdout } = runChild(TIMED_BENCH, { timed: true });

      const stats = reportedStats(stdout);
      const p50 = Number(field(stats, "p50"));
      const avg = Number(field(stats, "avg"));
      const max = Number(field(stats, "max"));
      expect({
        p50InNs: p50 >= 100_000 && p50 < 1_000_000,
        avgAboveTwiceMedian: avg > 2 * p50,
        avgBelowMax: avg < max,
      }).toStrictEqual({ p50InNs: true, avgAboveTwiceMedian: true, avgBelowMax: true });
    },
    CHILD_TIMEOUT_MS,
  );
});

describe.each([
  {
    label: "an unknown benchmark name",
    bench: "banana/missing",
    options: {},
    cause: "banana/missing",
  },
  {
    label: "no exposed gc",
    bench: SINKING_BENCH,
    options: { exposeGc: false },
    cause: "--expose-gc",
  },
  {
    label: "a body that throws",
    bench: THROWING_BENCH,
    options: { throwing: true },
    cause: THROWN,
  },
])("benchmarks/main.ts --child with $label", ({ bench, options, cause }) => {
  it(
    "exits 1, printing the cause on stderr only",
    () => {
      const failed = runChild(bench, options);

      expect({ status: failed.status, stdout: failed.stdout }).toStrictEqual({
        status: 1,
        stdout: "",
      });
      expect(failed.stderr).toContain(cause);
    },
    CHILD_TIMEOUT_MS,
  );
});

describe("benchmarks/main.ts --optimized", () => {
  let run: EntryRun;

  beforeAll(() => {
    buildRuntime();
    run = runEntry([BENCHES_FILTER, "--engine", "node,bun", "--optimized"]);
  }, COMPILE_TIMEOUT_MS);

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
    run = runEntry([BENCH_FILTER, "--engine", "bun", "--optimized"], { realBun: true });
  }, COMPILE_TIMEOUT_MS);

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
      run = runEntry([BENCH_FILTER, "--optimized"], { entry: benchmarkTreeWith(source) });
    }, COMPILE_TIMEOUT_MS);

    afterAll(() => {
      removeBenchmarkProjects();
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
  it(
    "exits 1 before starting a child, printing the cause on stderr only",
    () => {
      const failed = runEntry([BENCH_FILTER, "--optimized"], { refuseWrites: true });

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
