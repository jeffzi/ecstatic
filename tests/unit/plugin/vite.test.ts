import { SourceMap } from "node:module";
import { basename, join } from "node:path";

import { normalizePath } from "vite";
import { afterAll, beforeAll, describe, expect, it, onTestFinished } from "vitest";

import { fileKey } from "../../../src/plugin/file-key.js";
import ecstatic from "../../../src/plugin/vite.js";
import { locate } from "../optimizer/locate.js";
import {
  ASYNC_CALL,
  MAIN_FILE,
  MAIN_SOURCE,
  mainProject,
  MOVERS_CALL,
} from "../optimizer/main-project.js";
import { ROW_LOOP } from "../optimizer/printed.js";
import {
  projectPath,
  RUNTIME_TSCONFIG,
  runtimeCopy,
  runtimeProject,
  SPAWN_TIMEOUT_MS,
} from "../optimizer/project.js";
import { createProject, removeTempDirs } from "./tsconfig-fixtures.js";
import { type Host, startPlugin, transformCollecting } from "./vite-host.js";

/** The tsconfig holding the project's program; the root `tsconfig.json` only references it. */
const APP_TSCONFIG = "tsconfig.app.json";

/** A program module whose text on disk holds no ecstatic call. */
const HANDED_FILE = "app/handed.ts";

/** A module the app tsconfig excludes, so the program does not hold it. */
const EXCLUDED_FILE = "app/excluded.ts";

/** A declaration file the program holds. */
const AMBIENT_FILE = "app/ambient.d.ts";

/** A module the program holds inside the runtime's own source tree. */
const RUNTIME_FILE = "src/ecstatic/banana.ts";

/** The tsconfig whose program holds only declaration files, one of each kind. */
const AMBIENT_TSCONFIG = "tsconfig.ambient.json";

/** A module with no ecstatic call. */
const PLAIN_SOURCE = "export const banana = 1;\n";

/** An eligible `each` call, written as a module beside the runtime's own index. */
const RUNTIME_SOURCE = `import { archetype, component, each, type Storage } from "./index.js";

const Spot = component("Spot", { x: 0 });
const Marker = archetype([Spot]);
declare const markers: Storage<typeof Marker>;

each(markers, (e) => {
    e.Spot.x += 1;
});
`;

/** An ecstatic package root whose runtime has no `src/ecstatic/debug.ts`, so no rewrite over it can take its `DEBUG` copy. */
const BROKEN_ROOT = "vendor/broken";

/** A program module calling `each` over the runtime of {@link BROKEN_ROOT}. */
const BROKEN_FILE = "app/broken.ts";

/** The call of {@link BROKEN_SOURCE}, which bails as `INTERNAL`. */
const BROKEN_CALL = "each(markers";

/** An eligible `each` call over the runtime of {@link BROKEN_ROOT}. */
const BROKEN_SOURCE = `import { archetype, component, each, type Storage } from "../${BROKEN_ROOT}/src/ecstatic/index.js";

const Spot = component("Spot", { x: 0 });
const Marker = archetype([Spot]);
declare const markers: Storage<typeof Marker>;

${BROKEN_CALL}, (e) => {
    e.Spot.x += 1;
});
`;

/** {@link MAIN_SOURCE} with one more `each` call, over a storage typed without its archetype. */
const UNTYPED_SOURCE = `${MAIN_SOURCE}declare const untyped: Storage;

each(untyped, (e) => {
    void e.id;
});
`;

/** The runtime of the project copied under {@link BROKEN_ROOT}, without its `DEBUG` source. */
function brokenRuntime(): Record<string, string> {
  const broken = runtimeCopy(runtimeProject(), BROKEN_ROOT);
  delete broken[`${BROKEN_ROOT}/src/ecstatic/debug.ts`];
  return broken;
}

/**
 * The main project, with a solution-style root `tsconfig.json` referencing {@link APP_TSCONFIG},
 * which holds the program.
 */
function pluginProject(): Record<string, unknown> {
  return {
    ...mainProject({
      [HANDED_FILE]: "export {};\n",
      [EXCLUDED_FILE]: MAIN_SOURCE,
      [AMBIENT_FILE]: "export {};\n",
      [RUNTIME_FILE]: "export {};\n",
      [BROKEN_FILE]: BROKEN_SOURCE,
      ...brokenRuntime(),
    }),
    "ambient/one.d.ts": "export {};\n",
    "ambient/two.d.mts": "export {};\n",
    "ambient/three.d.cts": "export {};\n",
    "ambient/four.d.css.ts": "export {};\n",
    [AMBIENT_TSCONFIG]: { extends: "./tsconfig.base.json", include: ["ambient"] },
    "tsconfig.json": { files: [], references: [{ path: `./${APP_TSCONFIG}` }] },
    "tsconfig.base.json": RUNTIME_TSCONFIG,
    [APP_TSCONFIG]: { extends: "./tsconfig.base.json", exclude: [EXCLUDED_FILE] },
  };
}

/** Whether `value` is an object whose properties can be read. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** The code and source map a transform returned, or undefined when it returned no such pair. */
function rewriteOf(result: unknown): { code: string; map: SourceMap } | undefined {
  if (!isRecord(result)) return undefined;
  const { code, map } = result;
  if (typeof code !== "string" || !isRecord(map)) return undefined;
  const { mappings, sources } = map;
  if (typeof mappings !== "string" || !Array.isArray(sources)) return undefined;
  const payload = {
    version: 3,
    file: "",
    sourceRoot: "",
    sources: sources.map(String),
    names: [],
    sourcesContent: [],
    mappings,
  };
  return { code, map: new SourceMap(payload) };
}

/** The 0-based line and UTF-16 column of the first `token` in `text`. */
function positionOf(text: string, token: string): { line: number; column: number } {
  const before = text.slice(0, text.indexOf(token));
  return {
    line: before.split("\n").length - 1,
    column: before.length - (before.lastIndexOf("\n") + 1),
  };
}

/** Creates the plugin from `options` without checking their type, as a JavaScript config would. */
function createUnchecked(options: unknown): void {
  Reflect.apply(ecstatic, undefined, [options]);
}

let root: string;

/** The id Vite gives the slash-separated `rel` of the project: absolute, with `/` separators. */
function viteId(rel: string): string {
  return normalizePath(projectPath(root, rel));
}

beforeAll(() => {
  root = createProject(pluginProject());
});

afterAll(() => {
  removeTempDirs();
});

describe("ecstatic() for Vite", () => {
  describe("when created", () => {
    it("runs before Vite's TypeScript transform", () => {
      const plugin = ecstatic();

      expect(plugin.enforce).toBe("pre");
    });

    it.each([
      { name: "an unknown key", options: { banana: true }, key: "banana" },
      { name: "a strict that is not a boolean", options: { strict: "yes" }, key: "strict" },
      { name: "a project that is not a string", options: { project: 42 }, key: "project" },
    ])("throws naming $key and listing the valid keys when given $name", ({ options, key }) => {
      const create = () => {
        createUnchecked(options);
      };

      expect(create).toThrow(key);
      expect(create).toThrow("project");
      expect(create).toThrow("strict");
    });
  });

  describe("when the project option names the tsconfig", () => {
    let host: Host;

    beforeAll(async () => {
      host = await startPlugin(root, ecstatic({ project: APP_TSCONFIG }));
    }, SPAWN_TIMEOUT_MS);

    afterAll(() => host.close());

    it("returns the rewrite of the text Vite hands it, with a source map of that text", async () => {
      const result = await host.transform(MAIN_SOURCE, viteId(HANDED_FILE));

      expect(result).toStrictEqual({
        code: expect.stringContaining(ROW_LOOP),
        map: expect.objectContaining({ sourcesContent: [MAIN_SOURCE] }),
      });
    });

    it("maps the row loop of its rewrite to the call it replaces", async () => {
      const { line, column } = locate(projectPath(root, HANDED_FILE), MAIN_SOURCE, MOVERS_CALL);

      const output = rewriteOf(await host.transform(MAIN_SOURCE, viteId(HANDED_FILE)));

      const loop = positionOf(output?.code ?? "", ROW_LOOP);
      expect(output?.map.findEntry(loop.line, loop.column)).toMatchObject({
        originalSource: basename(HANDED_FILE),
        originalLine: line - 1,
        originalColumn: column - 1,
      });
    });

    it("returns nothing for a program module with no site to rewrite", async () => {
      const result = await host.transform(PLAIN_SOURCE, viteId(HANDED_FILE));

      expect(result).toBeUndefined();
    });

    it.each([
      "?raw",
      "?url",
      "?inline",
      "?no-inline",
      "?worker",
      "?worker_file&type=module",
      "?v=1&raw",
    ])("passes through a program module's id with the query %s", async (query) => {
      const result = await host.transform(MAIN_SOURCE, `${viteId(MAIN_FILE)}${query}`);

      expect(result).toBeUndefined();
    });

    it.each([
      {
        name: "a virtual id wrapping a program module's path",
        id: () => `\0${viteId(MAIN_FILE)}`,
        text: MAIN_SOURCE,
      },
      { name: "a virtual id", id: () => "virtual:banana", text: MAIN_SOURCE },
      { name: "a module outside the program", id: () => viteId(EXCLUDED_FILE), text: MAIN_SOURCE },
      { name: "a declaration file", id: () => viteId(AMBIENT_FILE), text: MAIN_SOURCE },
      {
        name: "a module inside an ecstatic runtime root",
        id: () => viteId(RUNTIME_FILE),
        text: RUNTIME_SOURCE,
      },
    ])("passes through $name", async ({ id, text }) => {
      const result = await host.transform(text, id());

      expect(result).toBeUndefined();
    });

    it.each([
      {
        name: "a warning bail",
        rel: HANDED_FILE,
        source: MAIN_SOURCE,
        call: ASYNC_CALL,
        reason: "the callback is async",
      },
      {
        name: "an INTERNAL bail",
        rel: BROKEN_FILE,
        source: BROKEN_SOURCE,
        call: BROKEN_CALL,
        reason: "internal error",
      },
    ])(
      "warns of $name with its message at its file, line, and column",
      async ({ rel, source, call, reason }) => {
        const { line, column } = locate(projectPath(root, rel), source, call);

        const { logs } = await transformCollecting(host, source, viteId(rel));

        expect(logs).toStrictEqual([
          expect.objectContaining({
            message: expect.stringContaining(reason),
            loc: { file: viteId(rel), line, column: column - 1 },
          }),
        ]);
      },
    );

    it("keeps a strict bail silent", async () => {
      const { logs } = await transformCollecting(host, UNTYPED_SOURCE, viteId(HANDED_FILE));

      expect(logs).toStrictEqual([
        expect.objectContaining({ message: expect.stringContaining("the callback is async") }),
      ]);
    });
  });

  describe("when strict", () => {
    let host: Host;

    beforeAll(async () => {
      host = await startPlugin(root, ecstatic({ project: APP_TSCONFIG, strict: true }));
    }, SPAWN_TIMEOUT_MS);

    afterAll(() => host.close());

    it("fails the transform of a module with bails, listing every bail it reports", async () => {
      const { line, column } = locate(projectPath(root, HANDED_FILE), UNTYPED_SOURCE, ASYNC_CALL);

      const transforming = host.transform(UNTYPED_SOURCE, viteId(HANDED_FILE));

      await expect(transforming).rejects.toThrow(
        `${viteId(HANDED_FILE)}:${line}:${column}: ecstatic: The each() call cannot be optimized (the callback is async)`,
      );
      await expect(transforming).rejects.toThrow("archetype shape is not known statically");
    });

    it("fails the transform of a module with an INTERNAL bail", async () => {
      const transforming = host.transform(BROKEN_SOURCE, viteId(BROKEN_FILE));

      await expect(transforming).rejects.toThrow("internal error");
    });
  });

  describe("when the default tsconfig's program holds no source files", () => {
    let host: Host;

    beforeAll(async () => {
      host = await startPlugin(root, ecstatic());
    }, SPAWN_TIMEOUT_MS);

    afterAll(() => host.close());

    it("rewrites nothing", async () => {
      const result = await host.transform(MAIN_SOURCE, viteId(MAIN_FILE));

      expect(result).toBeUndefined();
    });

    it("warns once, naming the tsconfig", async () => {
      await host.transform(MAIN_SOURCE, viteId(MAIN_FILE));
      await host.transform(MAIN_SOURCE, viteId(HANDED_FILE));

      expect(host.warnings).toStrictEqual([expect.stringContaining(join(root, "tsconfig.json"))]);
    });

    it("does not warn again when a watch build starts a rebuild", async () => {
      await host.buildStart();

      expect(host.warnings).toStrictEqual([expect.stringContaining(join(root, "tsconfig.json"))]);
    });
  });

  it(
    "warns that a program of declaration files only holds no source files",
    async () => {
      const host = await startPlugin(root, ecstatic({ project: AMBIENT_TSCONFIG }));
      onTestFinished(() => host.close());

      const { warnings } = host;

      expect(warnings).toStrictEqual([expect.stringContaining(join(root, AMBIENT_TSCONFIG))]);
    },
    SPAWN_TIMEOUT_MS,
  );
});

describe("fileKey", () => {
  it.each([
    { vite: "c:/work/app/main.ts", native: "C:\\work\\app\\main.ts" },
    { vite: "C:/work/app/main.ts", native: "c:\\work\\app\\main.ts" },
    { vite: "/home/me/app/main.ts", native: "/home/me/app/main.ts" },
  ])("matches the Vite id $vite to the native path $native", ({ vite, native }) => {
    const key = fileKey(vite);

    expect(key).toBe(fileKey(native));
  });

  it.each([
    { first: "C:/work/app/main.ts", second: "D:/work/app/main.ts" },
    { first: "C:/work/App/main.ts", second: "C:/work/app/main.ts" },
    { first: "/home/Me/app/main.ts", second: "/home/me/app/main.ts" },
  ])("tells $first from $second", ({ first, second }) => {
    const key = fileKey(first);

    expect(key).not.toBe(fileKey(second));
  });
});
