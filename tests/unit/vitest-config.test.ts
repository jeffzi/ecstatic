import { execFile } from "node:child_process";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createVitest, type TestProject, type Vitest } from "vitest/node";

import { packageBin } from "../package-bin.js";

const execFileAsync = promisify(execFile);

const ROOT = resolve(import.meta.dirname, "../..");

const SKIP_CHECKED = join(ROOT, "tests", "skip-checked.ts");

const CORPUS_TEST = join(ROOT, "tests", "optimizer", "corpus.test.ts");

const SHARED_OPTIONS = {
  allowOnly: false,
  requireAssertions: true,
  restoreMocks: true,
  unstubEnvs: true,
  unstubGlobals: true,
};

let vitest: Vitest;

beforeAll(async () => {
  vitest = await createVitest("test", { watch: false, config: join(ROOT, "vitest.config.ts") });
});

afterAll(async () => {
  await vitest.close();
});

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

  it("runs the corpus test in the fixtures project only", async () => {
    const holders = await Promise.all(
      vitest.projects.map(async (project) => {
        const { testFiles } = await project.globTestFiles();
        return testFiles.includes(CORPUS_TEST) ? [project.name] : [];
      }),
    );

    const names = holders.flat();

    expect(names).toStrictEqual(["fixtures"]);
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
      "unit-ndebug": { ndebug: true, skipsChecked: true },
      fixtures: { ndebug: undefined, skipsChecked: false },
      "fixtures-ndebug": { ndebug: true, skipsChecked: false },
    });
  });
});
