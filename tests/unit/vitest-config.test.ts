import { execFile } from "node:child_process";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createVitest, type TestProject, type Vitest } from "vitest/node";

import { archetype, component, each, type Storage } from "../../src/index.js";
import { packageBin } from "../package-bin.js";

const execFileAsync = promisify(execFile);

// The projects whose plugin list carries the optimizer. A test passes there whether or not a module
// was rewritten, since a rewrite keeps the runtime's behavior, so only the module text tells.
const OPTIMIZED_PROJECTS: ReadonlySet<string> = new Set(["unit-optimized", "unit-ndebug"]);

const ConfigProbe = component("ConfigProbe", { hits: 0 });
const ConfigProbeArch = archetype([ConfigProbe]);

/** An inline `each` the optimizer rewrites into a loop guarded by `assertShape`. */
function countHits(storage: Storage<typeof ConfigProbeArch>): void {
  each(storage, (e) => {
    e.ConfigProbe.hits += 1;
  });
}

const ROOT = resolve(import.meta.dirname, "../..");

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

  it("rewrites test modules through the optimizer in exactly the optimized projects", ({
    task,
  }) => {
    const rewritten = countHits.toString().includes("assertShape");

    expect(rewritten).toBe(OPTIMIZED_PROJECTS.has(task.file.projectName ?? ""));
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
      {
        cwd: root,
      },
    );

    const checked = new Set(stdout.split(/\r?\n/));
    expect(typecheckTestFiles).not.toHaveLength(0);
    expect(typecheckTestFiles.filter((file) => !checked.has(file))).toStrictEqual([]);
  });
});
