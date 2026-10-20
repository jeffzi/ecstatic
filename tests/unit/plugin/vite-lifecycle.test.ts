import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import {
  build,
  createServer,
  type InlineConfig,
  normalizePath,
  type Plugin,
  type PluginOption,
  type ViteDevServer,
} from "vite";
import { afterAll, beforeAll, describe, expect, it, onTestFinished, vi } from "vitest";

import type { ProjectView, Session } from "../../../src/plugin/optimizer/session.js";
import ecstatic from "../../../src/plugin/vite.js";
import {
  COMPONENTS_FILE,
  HEALTH_FILE,
  MAIN_FILE,
  MAIN_SOURCE,
  mainProject,
  STATUES_CALL,
} from "../optimizer/main-project.js";
import { processesStartedSince, runningProcesses, waitUntilDead } from "../optimizer/processes.js";
import { projectPath, SPAWN_TIMEOUT_MS } from "../optimizer/project.js";
import { createProject, removeTempDirs, writeFixture } from "./tsconfig-fixtures.js";
import { startPlugin, transformCollecting } from "./vite-host.js";

/** Whether this platform can suspend a process, so a test can hold a request unanswered. */
const CAN_SUSPEND = process.platform !== "win32";

/** How long a suspended compiler process is given to receive a request before it is killed. */
const SUSPENDED_SETTLE_MS = 50;

/** The analysis module, as this file names it to mock it. */
const ANALYZE_MODULE = "../../../src/plugin/optimizer/analysis/analyze.js";

/** The session module, as this file names it to mock it. */
const SESSION_MODULE = "../../../src/plugin/optimizer/session.js";

/** How long a watch build or a dev server may take to see a change on disk and act on it. */
const REBUILD_TIMEOUT_MS = 15_000;

/** The main project's components with a field added to `Position`, which every shape key of it names. */
const EDITED_COMPONENTS = `import { component } from "../src/ecstatic/index.js";

export const Position = component("Position", { x: 0, y: 0, banana: 0 });
export const Velocity = component("Velocity", { dx: 0, dy: 0 });
`;

/** The field {@link EDITED_COMPONENTS} adds. */
const ADDED_FIELD = "banana";

/** What a mocked listing of the program's files rejects with. */
const LISTING_FAILURE = "listing went bananas";

/** A module that names its archetype only as a type, so the bundle never imports the schema. */
const TYPED_SOURCE = `import { each, type Storage } from "../src/ecstatic/index.js";
import type { Mover } from "./schema.js";

declare const movers: Storage<typeof Mover>;

each(movers, (e) => {
    e.Position.x += 1;
});
`;

const SCHEMA_FILE = "app/schema.ts";

/** The schema {@link TYPED_SOURCE} names, its one component holding `fields`. */
function schemaSource(fields: string): string {
  return `import { archetype, component } from "../src/ecstatic/index.js";

export const Position = component("Position", { ${fields} });
export const Mover = archetype([Position]);
`;
}

/** What a probe saw of a build: the compiler processes running and the code of each module. */
interface Probe {
  readonly plugin: Plugin;
  /** Every child process of this process that was running at a module load, apart from those running before. */
  readonly processes: Set<number>;
  /** The latest code of each module id, as the plugins before the probe left it. */
  readonly outputs: Map<string, string>;
  /** How many bundles the build generated. */
  bundles: number;
}

/**
 * A plugin that records, at each module load, the child processes started since `before`, and the
 * code each transform hands it. Placed after `ecstatic()`, it sees the plugin's output.
 *
 * @param before - The child processes running before the build.
 * @returns The probe, whose fields fill in as the build runs.
 */
function processProbe(before: ReadonlySet<number>): Probe {
  let snapshots = Promise.resolve();
  const probe: Probe = {
    processes: new Set(),
    outputs: new Map(),
    bundles: 0,
    plugin: {
      name: "process-probe",
      enforce: "pre",
      async load() {
        const previous = snapshots;
        snapshots = (async () => {
          await previous;
          for (const pid of await processesStartedSince(before)) probe.processes.add(pid);
        })();
        await snapshots;
        return null;
      },
      transform(code, id) {
        probe.outputs.set(id, code);
        return null;
      },
      generateBundle() {
        probe.bundles += 1;
      },
    },
  };
  return probe;
}

/** A Vite build of the main project at `root`, from `app/main.ts`, through `plugins`. */
function buildConfig(root: string, plugins: PluginOption[]): InlineConfig {
  return {
    root,
    configFile: false,
    logLevel: "silent",
    plugins,
    build: {
      outDir: join(root, "dist"),
      emptyOutDir: true,
      minify: false,
      rolldownOptions: { input: projectPath(root, MAIN_FILE), external: [/^ecstatic\//u] },
    },
  };
}

async function waitForBundles(probe: Probe, count: number): Promise<void> {
  await vi.waitFor(
    () => {
      expect(probe.bundles).toBeGreaterThanOrEqual(count);
    },
    { timeout: REBUILD_TIMEOUT_MS },
  );
}

async function waitUntilAllDead(processes: Iterable<number>): Promise<void> {
  await Promise.all([...processes].map(waitUntilDead));
}

/** A fresh import of the plugin, after the mocks a case registered; the mocks go when the case ends. */
async function freshEcstatic(): Promise<typeof ecstatic> {
  vi.resetModules();
  onTestFinished(() => {
    vi.doUnmock("typescript/async");
    vi.doUnmock(SESSION_MODULE);
    vi.doUnmock(ANALYZE_MODULE);
    vi.resetModules();
  });
  const fresh = await import("../../../src/plugin/vite.js");
  return fresh.default;
}

/** An error as Node's module loader raises it, with its `code`. */
function loaderError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

/** `view`, except that listing the program's files rejects with {@link LISTING_FAILURE}. */
function failingListing(view: ProjectView): ProjectView {
  return new Proxy(view, {
    get(target, key) {
      if (key === "sourceFileNames") return () => Promise.reject(new Error(LISTING_FAILURE));
      const value: unknown = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

let root: string;

/** The id Vite gives the slash-separated `rel` of `dir`: absolute, with `/` separators. */
function viteId(dir: string, rel: string): string {
  return normalizePath(projectPath(dir, rel));
}

beforeAll(() => {
  root = createProject(mainProject());
});

afterAll(() => {
  removeTempDirs();
});

describe("ecstatic() for Vite", () => {
  describe("when a build finishes", () => {
    let probe: Probe;

    beforeAll(async () => {
      probe = processProbe(await runningProcesses());
      await build(buildConfig(root, [ecstatic(), probe.plugin]));
    }, SPAWN_TIMEOUT_MS);

    it("keeps one compiler process for the whole build", () => {
      expect(probe.processes.size).toBe(1);
    });

    it("ends the compiler process", async () => {
      await expect(waitUntilAllDead(probe.processes)).resolves.toBeUndefined();
    });
  });

  it(
    "ends the compiler process when the build fails",
    async () => {
      const probe = processProbe(await runningProcesses());

      const failure: unknown = await build(
        buildConfig(root, [ecstatic({ strict: true }), probe.plugin]),
      ).then(
        () => undefined,
        (error: unknown) => error,
      );

      expect(failure).toBeInstanceOf(Error);
      expect(probe.processes.size).toBe(1);
      await expect(waitUntilAllDead(probe.processes)).resolves.toBeUndefined();
    },
    SPAWN_TIMEOUT_MS,
  );

  describe("in a watch build", () => {
    let watchRoot: string;
    let probe: Probe;
    let watcher: { close(): Promise<void> } | undefined;

    beforeAll(async () => {
      watchRoot = createProject(mainProject());
      probe = processProbe(await runningProcesses());
      const config = buildConfig(watchRoot, [ecstatic(), probe.plugin]);
      const output = await build({ ...config, build: { ...config.build, watch: {} } });
      if (!("close" in output)) throw new Error("the watch build returned no watcher");
      watcher = output;
      await waitForBundles(probe, 1);
      writeFixture(projectPath(watchRoot, COMPONENTS_FILE), EDITED_COMPONENTS);
      await waitForBundles(probe, 2);
    }, SPAWN_TIMEOUT_MS);

    afterAll(async () => {
      await watcher?.close();
    });

    it("re-transforms a module after a declaration file its rewrite consulted changes", () => {
      const output = probe.outputs.get(viteId(watchRoot, MAIN_FILE));

      expect(output).toContain(ADDED_FIELD);
    });

    it("keeps one compiler process across rebuilds", () => {
      expect(probe.processes.size).toBe(1);
    });

    it("ends the compiler process when the watcher closes", async () => {
      const closing = watcher?.close();
      watcher = undefined;
      await closing;

      await expect(waitUntilAllDead(probe.processes)).resolves.toBeUndefined();
    });
  });

  describe("in a watch build whose module names its schema only as a type", () => {
    let watchRoot: string;
    let probe: Probe;
    let watcher: { close(): Promise<void> } | undefined;

    beforeAll(async () => {
      watchRoot = createProject(
        mainProject({ [MAIN_FILE]: TYPED_SOURCE, [SCHEMA_FILE]: schemaSource("x: 0") }),
      );
      probe = processProbe(await runningProcesses());
      const config = buildConfig(watchRoot, [ecstatic(), probe.plugin]);
      const output = await build({ ...config, build: { ...config.build, watch: {} } });
      if (!("close" in output)) throw new Error("the watch build returned no watcher");
      watcher = output;
      await waitForBundles(probe, 1);
      writeFixture(projectPath(watchRoot, SCHEMA_FILE), schemaSource(`x: 0, ${ADDED_FIELD}: 0`));
      await waitForBundles(probe, 2);
    }, SPAWN_TIMEOUT_MS);

    afterAll(async () => {
      await watcher?.close();
    });

    it("re-transforms the module after the schema its rewrite consulted changes", () => {
      const output = probe.outputs.get(viteId(watchRoot, MAIN_FILE));

      expect(output).toContain(ADDED_FIELD);
    });
  });

  describe("in a dev server", () => {
    /** A dev server over a new project, with the compiler processes serving its main module started. */
    interface DevServer {
      readonly root: string;
      readonly server: ViteDevServer;
      readonly processes: readonly number[];
      readonly before: ReadonlySet<number>;
    }

    /** The code `server` serves for the main module. */
    async function servedMain(server: ViteDevServer): Promise<string | undefined> {
      const result = await server.environments.client.transformRequest(`/${MAIN_FILE}`);
      return result?.code;
    }

    /** Starts a dev server over a new project and serves its main module once. */
    async function startDevServer(): Promise<DevServer> {
      const devRoot = createProject(mainProject());
      const before = await runningProcesses();
      const server = await createServer({
        root: devRoot,
        configFile: false,
        logLevel: "silent",
        appType: "custom",
        resolve: {
          alias: { "ecstatic/internal": projectPath(devRoot, "src/ecstatic/internal.ts") },
        },
        server: { middlewareMode: true, ws: false },
        plugins: [ecstatic()],
      });
      await servedMain(server);
      const processes = await processesStartedSince(before);
      return { root: devRoot, server, processes, before };
    }

    it(
      "serves a module rewritten again, by the same compiler process, after a declaration file its rewrite consulted changes",
      async () => {
        const { root: devRoot, server, processes, before } = await startDevServer();
        onTestFinished(() => server.close());

        writeFixture(projectPath(devRoot, COMPONENTS_FILE), EDITED_COMPONENTS);

        await expect(
          vi.waitFor(
            async () => {
              expect(await servedMain(server)).toContain(ADDED_FIELD);
            },
            { timeout: REBUILD_TIMEOUT_MS },
          ),
        ).resolves.toBeUndefined();
        const seen = new Set([...processes, ...(await processesStartedSince(before))]);
        expect(seen.size).toBe(1);
      },
      SPAWN_TIMEOUT_MS,
    );

    it(
      "ends the compiler process when the server closes",
      async () => {
        const { server, processes } = await startDevServer();

        await server.close();

        expect(processes).toHaveLength(1);
        await expect(waitUntilAllDead(processes)).resolves.toBeUndefined();
      },
      SPAWN_TIMEOUT_MS,
    );
  });

  describe("when a file Vite never transformed changes on disk", () => {
    it.each([
      {
        event: "update" as const,
        edit: (file: string) => {
          writeFixture(file, "export const banana = 1;\n");
        },
      },
      {
        event: "delete" as const,
        edit: (file: string) => {
          rmSync(file);
        },
      },
    ])(
      "rewrites the next module from the file as the $event left it",
      async ({ event, edit }) => {
        const changedRoot = createProject(mainProject());
        const host = await startPlugin(changedRoot, ecstatic());
        onTestFinished(() => host.close());
        edit(projectPath(changedRoot, HEALTH_FILE));
        await host.watchChange(viteId(changedRoot, HEALTH_FILE), event);

        const result = await host.transform(MAIN_SOURCE, viteId(changedRoot, MAIN_FILE));

        expect(result).toStrictEqual(
          expect.objectContaining({ code: expect.stringContaining(STATUES_CALL) }),
        );
      },
      SPAWN_TIMEOUT_MS,
    );
  });

  it(
    "fails the module being transformed, naming the exit, when the compiler process died before it",
    async () => {
      const before = await runningProcesses();
      const host = await startPlugin(root, ecstatic());
      onTestFinished(() => host.close());
      const started = await processesStartedSince(before);
      for (const pid of started) process.kill(pid, "SIGKILL");
      await waitUntilAllDead(started);

      const transforming = host.transform(MAIN_SOURCE, viteId(root, MAIN_FILE));

      await expect(transforming).rejects.toThrow(/exited/u);
    },
    SPAWN_TIMEOUT_MS,
  );

  it.skipIf(!CAN_SUSPEND)(
    "fails the module being transformed, naming the exit, when the compiler process dies during it",
    async () => {
      const before = await runningProcesses();
      const host = await startPlugin(root, ecstatic());
      onTestFinished(() => host.close());
      const started = await processesStartedSince(before);
      for (const pid of started) process.kill(pid, "SIGSTOP");

      const transforming = host.transform(MAIN_SOURCE, viteId(root, MAIN_FILE));
      await sleep(SUSPENDED_SETTLE_MS);
      for (const pid of started) process.kill(pid, "SIGKILL");

      await expect(transforming).rejects.toThrow(/exited/u);
    },
    SPAWN_TIMEOUT_MS,
  );

  describe("when the disk deletes a file it had transformed", () => {
    it.each([
      { name: "keeps the call needing it", recreated: false, keptCalls: [STATUES_CALL] },
      {
        name: "rewrites the call again once the disk re-creates it",
        recreated: true,
        keptCalls: [],
      },
    ])(
      "$name",
      async ({ recreated, keptCalls }) => {
        const changedRoot = createProject(mainProject());
        const host = await startPlugin(changedRoot, ecstatic());
        onTestFinished(() => host.close());
        const health = projectPath(changedRoot, HEALTH_FILE);
        const healthText = readFileSync(health, "utf8");
        await host.transform(healthText, viteId(changedRoot, HEALTH_FILE));
        rmSync(health);
        await host.watchChange(viteId(changedRoot, HEALTH_FILE), "delete");
        if (recreated) {
          writeFixture(health, healthText);
          await host.watchChange(viteId(changedRoot, HEALTH_FILE), "create");
        }

        const result = await host.transform(MAIN_SOURCE, viteId(changedRoot, MAIN_FILE));

        const code =
          typeof result === "object" && result !== null && "code" in result ? result.code : "";
        expect([STATUES_CALL].filter((call) => String(code).includes(call))).toStrictEqual(
          keptCalls,
        );
      },
      SPAWN_TIMEOUT_MS,
    );
  });

  it(
    "warns of a file it could not analyze at the file's start",
    async () => {
      vi.doMock(ANALYZE_MODULE, async (importOriginal) => {
        const original =
          await importOriginal<
            typeof import("../../../src/plugin/optimizer/analysis/analyze.js")
          >();
        return { ...original, analyze: () => Promise.reject(new Error("banana split")) };
      });
      const plugin = await freshEcstatic();
      const host = await startPlugin(root, plugin());
      onTestFinished(() => host.close());

      const { logs } = await transformCollecting(host, MAIN_SOURCE, viteId(root, MAIN_FILE));

      expect(logs).toStrictEqual([
        expect.objectContaining({
          message: expect.stringContaining("could not be analyzed"),
          loc: { file: viteId(root, MAIN_FILE), line: 1, column: 0 },
        }),
      ]);
    },
    SPAWN_TIMEOUT_MS,
  );

  describe("when the build starts", () => {
    it(
      "fails naming the tsconfig and the cause when the tsconfig cannot be loaded",
      async () => {
        const missing = "banana.json";

        const starting = startPlugin(root, ecstatic({ project: missing }));

        await expect(starting).rejects.toThrow(join(root, missing));
        await expect(starting).rejects.toThrow("could not read file");
      },
      SPAWN_TIMEOUT_MS,
    );

    it.each([
      {
        name: "typescript is missing",
        error: loaderError(
          "ERR_MODULE_NOT_FOUND",
          "Cannot find package 'typescript' imported from /app/node_modules/ecstatic/dist/plugin/optimizer/compiler.js",
        ),
        cause: /`typescript` package.*not installed/u,
      },
      {
        name: "typescript has no typescript/async export",
        error: loaderError(
          "ERR_PACKAGE_PATH_NOT_EXPORTED",
          `Package subpath './async' is not defined by "exports" in /app/node_modules/typescript/package.json`,
        ),
        cause: /no `typescript\/async` export.*7\.1 or later/u,
      },
    ])("fails naming the cause when $name", async ({ error, cause }) => {
      vi.doMock("typescript/async", () => {
        throw error;
      });
      const plugin = await freshEcstatic();

      const starting = startPlugin(root, plugin());

      await expect(starting).rejects.toThrow(cause);
    });

    it(
      "fails naming the cause when the compiler process cannot start",
      async () => {
        const executable = join(root, "no-such-compiler");
        vi.doMock("typescript/async", async (importOriginal) => {
          const original = await importOriginal<typeof import("typescript/async")>();
          return {
            ...original,
            API: class extends original.API {
              constructor(options: ConstructorParameters<typeof original.API>[0] = {}) {
                super({ ...options, tsserverPath: executable });
              }
            },
          };
        });
        const plugin = await freshEcstatic();

        const starting = startPlugin(root, plugin());

        await expect(starting).rejects.toThrow(executable);
      },
      SPAWN_TIMEOUT_MS,
    );

    it(
      "closes the session it opened when listing the program's files fails",
      async () => {
        const opened: Session[] = [];
        vi.doMock(SESSION_MODULE, async (importOriginal) => {
          const original =
            await importOriginal<typeof import("../../../src/plugin/optimizer/session.js")>();
          return {
            ...original,
            openSession: async (...args: Parameters<typeof original.openSession>) => {
              const session = await original.openSession(...args);
              opened.push(session);
              const update = session.update.bind(session);
              session.update = async (files) => failingListing(await update(files));
              return session;
            },
          };
        });
        const plugin = await freshEcstatic();

        const starting = startPlugin(root, plugin());

        await expect(starting).rejects.toThrow(LISTING_FAILURE);
        await expect(opened[0]?.update()).rejects.toThrow(/closed/u);
      },
      SPAWN_TIMEOUT_MS,
    );
  });
});
