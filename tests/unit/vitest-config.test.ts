import { execFile } from "node:child_process";
import { globSync } from "node:fs";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { normalizePath } from "vite";
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it,
  onTestFinished,
  type TestContext,
  vi,
} from "vitest";
import { createVitest, type TestProject, type Vitest } from "vitest/node";

import { packageBin } from "../package-bin.js";
import { countHits } from "./inline-each.js";
import { processesStartedSince, runningProcesses, waitUntilDead } from "./optimizer/processes.js";
import { SPAWN_TIMEOUT_MS } from "./optimizer/project.js";

const execFileAsync = promisify(execFile);

// The projects whose plugin list carries the optimizer. A test passes there whether or not a module
// was rewritten, since a rewrite keeps the runtime's behavior, so only the module text tells.
const OPTIMIZED_PROJECTS: ReadonlySet<string> = new Set(["unit-optimized", "unit-ndebug"]);

// Each optimized project starts a compiler process of about 218 MB, so the run-ending checks open
// their own Vitest from one project rather than from every project that runs this file.
const LIFECYCLE_PROJECT = "unit";

const ROOT = resolve(import.meta.dirname, "../..");

/** The path of a file in `tests/integration`, named the way Vitest names modules. */
function integrationTestFile(name: string): string {
  return normalizePath(join(ROOT, "tests", "integration", name));
}

const VITEST_CONFIG = join(ROOT, "vitest.config.ts");

// What the optimizer's rewrite of an inline `each` adds to a module: the shape guard's call.
const REWRITE_MARKER = "assertShape";

// Vitest names test and setup files the way Vite names modules: absolute, with `/` separators.
const SKIP_CHECKED = normalizePath(join(ROOT, "tests", "skip-checked.ts"));

const CORPUS_TEST = integrationTestFile("corpus.test.ts");

const VITE_SMOKE_TEST = integrationTestFile("vite-smoke.test.ts");

const GOLDEN_LOADER_TEST = integrationTestFile("golden-loader.test.ts");

const UNSTRIPPED_TEST = integrationTestFile("unstripped.test.ts");

const INLINE_EACH_MODULE = join(ROOT, "tests", "unit", "inline-each.ts");

// The optimizer's and the plugin's own tests drive the optimizer directly; an optimized project
// runs only the tests of the runtime it rewrites.
const RUNTIME_UNIT_TESTS = globSync("tests/unit/**/*.test.ts", { cwd: ROOT })
  .filter((file) => !/^tests[\\/]unit[\\/](optimizer|plugin)[\\/]/u.test(file))
  .map((file) => normalizePath(join(ROOT, file)))
  .toSorted();

const SHARED_OPTIONS = {
  allowOnly: false,
  requireAssertions: true,
  restoreMocks: true,
  unstubEnvs: true,
  unstubGlobals: true,
};

let vitest: Vitest;

function openVitest(): Promise<Vitest> {
  return createVitest("test", { watch: false, config: VITEST_CONFIG });
}

beforeAll(async () => {
  vitest = await openVitest();
});

afterAll(async () => {
  await vitest.close();
});

/** What a Vitest saw of a run that transformed {@link INLINE_EACH_MODULE} in every project, then closed. */
interface ClosedRun {
  /** The names of the projects whose transform of the file calls `assertShape`. */
  readonly rewritten: readonly string[];
  /** The child processes this process started while the projects transformed the file. */
  readonly started: readonly number[];
}

/** Opens a Vitest over the config, transforms {@link INLINE_EACH_MODULE} in every project, and closes it. */
async function transformThenClose(): Promise<ClosedRun> {
  const before = await runningProcesses();
  const run = await openVitest();
  const codes = await Promise.all(
    run.projects.map(async (project) => {
      const result = await project.vite.environments.ssr.transformRequest(INLINE_EACH_MODULE);
      return { name: project.name, code: result?.code ?? "" };
    }),
  );
  const started = await processesStartedSince(before);
  await run.close();
  const rewritten = codes
    .filter(({ code }) => code.includes(REWRITE_MARKER))
    .map(({ name }) => name);
  return { rewritten: rewritten.toSorted(), started };
}

/** Skips the running test unless it runs in {@link LIFECYCLE_PROJECT}. */
function skipOutsideLifecycleProject({ skip, task }: TestContext): void {
  skip(task.file.projectName !== LIFECYCLE_PROJECT, `checked from ${LIFECYCLE_PROJECT}`);
}

/** Picks the resolved options every project must share with the root config. */
function sharedOptions(project: TestProject): typeof SHARED_OPTIONS {
  const {
    allowOnly,
    expect: expectOptions,
    restoreMocks,
    unstubEnvs,
    unstubGlobals,
  } = project.config;
  return {
    allowOnly,
    requireAssertions: expectOptions.requireAssertions ?? false,
    restoreMocks,
    unstubEnvs,
    unstubGlobals,
  };
}

describe("vitest config", () => {
  it("applies the shared test options to every project", () => {
    const expected = Object.fromEntries(
      vitest.projects.map((project) => [project.name, SHARED_OPTIONS]),
    );

    const actual = Object.fromEntries(
      vitest.projects.map((project) => [project.name, sharedOptions(project)]),
    );

    expect(actual).toStrictEqual(expected);
  });

  it("rewrites test modules through the optimizer in exactly the optimized projects", ({
    task,
  }) => {
    const rewritten = countHits.toString().includes(REWRITE_MARKER);

    expect(rewritten).toBe(OPTIMIZED_PROJECTS.has(task.file.projectName ?? ""));
  });

  it("starts one optimizer per optimized project, each on the tests tsconfig", async () => {
    const options: unknown[] = [];
    vi.doMock("../../src/plugin/vite.js", () => ({
      default: (given: unknown) => {
        options.push(given);
        return { name: "ecstatic" };
      },
    }));
    onTestFinished(() => {
      vi.doUnmock("../../src/plugin/vite.js");
    });
    vi.resetModules();

    await import("../../vitest.config.js");

    expect(options).toStrictEqual(
      [...OPTIMIZED_PROJECTS].map(() => ({ project: "tests/tsconfig.json" })),
    );
  });

  it.each([...OPTIMIZED_PROJECTS])(
    "runs the runtime unit tests, without the optimizer and plugin tests, in %s",
    async (name) => {
      const { testFiles } = await vitest.getProjectByName(name).globTestFiles();

      expect(testFiles.toSorted()).toStrictEqual(RUNTIME_UNIT_TESTS);
    },
  );

  it("type-checks every type test file of the types project", async () => {
    const types = vitest.getProjectByName("types");
    const { root, typecheck } = types.config;
    const tsconfigArgs =
      typecheck.tsconfig === undefined ? [] : ["-p", resolve(root, typecheck.tsconfig)];
    const { typecheckTestFiles } = await types.globTestFiles();

    const { stdout } = await execFileAsync(
      process.execPath,
      [packageBin("typescript", typecheck.checker), "--listFilesOnly", ...tsconfigArgs],
      { cwd: root },
    );

    const checked = new Set(stdout.split(/\r?\n/));
    expect(typecheckTestFiles).not.toHaveLength(0);
    expect(typecheckTestFiles.filter((file) => !checked.has(file))).toStrictEqual([]);
  });

  it.each([
    { name: "corpus test", file: CORPUS_TEST },
    { name: "Vite smoke test", file: VITE_SMOKE_TEST },
    { name: "golden loader test", file: GOLDEN_LOADER_TEST },
    { name: "unstripped-guard test", file: UNSTRIPPED_TEST },
  ])("runs the $name in the integration project only", async ({ file }) => {
    const holders = await Promise.all(
      vitest.projects.map(async (project) => {
        const { testFiles } = await project.globTestFiles();
        return testFiles.includes(file) ? [project.name] : [];
      }),
    );

    const names = holders.flat();

    expect(names).toStrictEqual(["integration"]);
  });

  it("defines NDEBUG and skips #checked tests exactly in the ndebug projects", () => {
    const runtimeProjects = vitest.projects.filter((project) => project.name !== "types");

    const actual = Object.fromEntries(
      runtimeProjects.map((project) => [
        project.name,
        {
          ndebug: Reflect.get(project.config.defines, "NDEBUG"),
          skipsChecked: project.config.setupFiles.includes(SKIP_CHECKED),
        },
      ]),
    );

    expect(actual).toStrictEqual({
      unit: { ndebug: undefined, skipsChecked: false },
      "unit-optimized": { ndebug: undefined, skipsChecked: false },
      "unit-ndebug": { ndebug: true, skipsChecked: true },
      integration: { ndebug: undefined, skipsChecked: false },
      "integration-ndebug": { ndebug: true, skipsChecked: false },
    });
  });

  describe("when a run closes after every project transformed a module with an inline each", () => {
    let closed: Promise<ClosedRun> | undefined;

    /** The closed run, opened by whichever test of this group runs first. */
    async function closedRun(): Promise<ClosedRun> {
      closed ??= transformThenClose();
      return closed;
    }

    it(
      "rewrote the module in exactly the optimized projects",
      async (context) => {
        skipOutsideLifecycleProject(context);

        const { rewritten } = await closedRun();

        expect(rewritten).toStrictEqual([...OPTIMIZED_PROJECTS].toSorted());
      },
      SPAWN_TIMEOUT_MS,
    );

    it(
      "ends the one compiler process each optimized project started",
      async (context) => {
        skipOutsideLifecycleProject(context);

        const { started } = await closedRun();

        expect(started).toHaveLength(OPTIMIZED_PROJECTS.size);
        await expect(Promise.all(started.map(waitUntilDead))).resolves.toBeDefined();
      },
      SPAWN_TIMEOUT_MS,
    );
  });
});
