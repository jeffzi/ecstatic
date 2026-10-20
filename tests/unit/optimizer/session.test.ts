import { execFile } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

import { getTouchingPropertyName } from "typescript/ast";
import { afterAll, beforeAll, describe, expect, it, onTestFinished, vi } from "vitest";

import {
  propertiesOfType,
  resolveSymbol,
  symbolName,
  typeOfSymbol,
} from "../../../src/plugin/optimizer/compiler.js";
import {
  openSession,
  type ProjectView,
  type Session,
  type SessionOptions,
} from "../../../src/plugin/optimizer/session.js";
import { appTsconfig, removeProjects, runtimeProject, writeProject } from "./project.js";

const execFileAsync = promisify(execFile);

/** How long a case that starts its own compiler process may take on a slow CI runner. */
const SPAWN_TIMEOUT_MS = 30_000;

const DEBUG_SOURCE = runtimeProject()["src/ecstatic/debug.ts"] ?? "";

const PROJECT = {
  "tsconfig.json": appTsconfig(),
  "app/schema.ts": "export interface Velocity { dx: number; dy: number }\n",
  "app/main.ts":
    'import type { Velocity } from "./schema.js";\nexport declare const v: Velocity;\n',
  "app/loaded.ts": "export const loaded = { x: 1 };\n",
  "app/served.ts": "export const served = { x: 1 };\n",
  "app/first.ts": "export const first = { x: 1 };\n",
  "app/second.ts": "export const second = { x: 1 };\n",
  "app/disk.ts": "export const disk = { x: 1 };\n",
  "app/unannounced.ts": "export const unannounced = { x: 1 };\n",
  "app/emitted.ts": "export const answer: number = 1;\n",
  "node_modules/ecstatic/package.json":
    '{"name": "ecstatic", "type": "module", "types": "dist/index.d.ts"}',
  "node_modules/ecstatic/dist/index.d.ts": "export declare const DEBUG: boolean;\n",
  "node_modules/ecstatic/src/ecstatic/debug.ts": DEBUG_SOURCE,
};

/** A project whose tsconfig lets it emit, for the cases that must hold either way. */
const EMITTING_PROJECT = {
  "tsconfig.json": appTsconfig({ noEmit: false, outDir: "out" }),
  "app/emitted.ts": "export const answer: number = 1;\n",
};

let root = "";
let session: Session;
let emittingRoot = "";
let emittingSession: Session;

beforeAll(async () => {
  root = writeProject(PROJECT);
  emittingRoot = writeProject(EMITTING_PROJECT);
  [session, emittingSession] = await Promise.all([
    openSession(join(root, "tsconfig.json")),
    openSession(join(emittingRoot, "tsconfig.json")),
  ]);
}, SPAWN_TIMEOUT_MS);

afterAll(async () => {
  await Promise.all([session.close(), emittingSession.close()]);
  removeProjects();
});

/** The absolute path of `rel` under `dir`, the shared project by default. */
function file(rel: string, dir = root): string {
  return join(dir, ...rel.split("/"));
}

/** The property names of the type of the value declared as `name` in `rel`, as `view`'s checker sees it. */
async function propertyNames(view: ProjectView, rel: string, name: string): Promise<string[]> {
  const source = await view.sourceFile(file(rel));
  const identifier = getTouchingPropertyName(source, source.text.indexOf(`const ${name}`) + 6);
  const symbol = await resolveSymbol(view.checker, identifier);
  if (symbol === undefined) throw new Error(`${name} resolves to no symbol in ${rel}`);
  const type = await typeOfSymbol(view.checker, symbol);
  return (await propertiesOfType(view.checker, type)).map(symbolName);
}

/** The process IDs of this process's live children. */
async function childProcessIds(): Promise<number[]> {
  const { stdout } =
    process.platform === "win32"
      ? await execFileAsync("powershell.exe", [
          "-NoProfile",
          "-Command",
          `Get-CimInstance Win32_Process -Filter "ParentProcessId=${process.pid}" | ForEach-Object { "$($_.ProcessId) ${process.pid}" }`,
        ])
      : await execFileAsync("ps", ["-A", "-o", "pid=,ppid="]);
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim().split(/\s+/).map(Number))
    .flatMap(([pid, parent]) => (pid !== undefined && parent === process.pid ? [pid] : []))
    .filter(isAlive);
}

/** Whether `pid` is running; a process owned by another user answers EPERM and still counts. */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
}

async function waitUntilDead(pid: number): Promise<void> {
  await vi.waitFor(() => {
    expect(isAlive(pid)).toBe(false);
  });
}

interface OwnSession {
  readonly session: Session;
  readonly pid: number;
  readonly dir: string;
}

/** Opens a session on a fresh copy of the shared project and returns it with its compiler's process ID and directory. */
async function openOwnSession(options: SessionOptions = {}): Promise<OwnSession> {
  const before = new Set(await childProcessIds());
  const dir = writeProject(PROJECT);
  const own = await openSession(join(dir, "tsconfig.json"), options);
  const started = (await childProcessIds()).filter((pid) => !before.has(pid));
  const [pid] = started;
  if (started.length !== 1 || pid === undefined) {
    throw new Error(`expected one new compiler process, found ${started.length}`);
  }
  return { session: own, pid, dir };
}

/** Whether this platform can suspend a process, so a test can hold its requests unanswered. */
const CAN_SUSPEND = process.platform !== "win32";

describe("openSession", () => {
  it("loads the project its tsconfig names", async () => {
    const view = await session.update();

    const names = await propertyNames(view, "app/loaded.ts", "loaded");

    expect(names).toStrictEqual(["x"]);
  });

  describe("when the tsconfig cannot be loaded", () => {
    it.each([
      {
        name: "missing",
        files: { "app/main.ts": "export {};\n" },
        diagnostic: "could not read file",
      },
      {
        name: "unreadable",
        files: { "tsconfig.json/placeholder.txt": "", "app/main.ts": "export {};\n" },
        diagnostic: "could not read file",
      },
      {
        name: "unparsable",
        files: { "tsconfig.json": '{ "include": ["app/**/*.ts"],', "app/main.ts": "export {};\n" },
        diagnostic: "'}' expected",
      },
    ])(
      "rejects naming the tsconfig and the compiler's diagnostic when $name",
      async ({ files, diagnostic }) => {
        const tsconfig = join(writeProject(files), "tsconfig.json");

        const opening = openSession(tsconfig);

        await expect(opening).rejects.toThrow(tsconfig);
        await expect(opening).rejects.toThrow(diagnostic);
      },
      SPAWN_TIMEOUT_MS,
    );
  });

  it("rejects naming the tsconfig and the cause when the compiler process cannot start", async () => {
    const dir = writeProject(PROJECT);
    const tsconfig = join(dir, "tsconfig.json");
    const executable = join(dir, "no-such-compiler");

    const opening = openSession(tsconfig, { executable });

    await expect(opening).rejects.toThrow(`cannot open a session on ${tsconfig}`);
    await expect(opening).rejects.toThrow(executable);
  });
});

describe("Session.update", () => {
  it("answers from the served text in place of the disk's", async () => {
    const view = await session.update({
      [file("app/served.ts")]: "export const served = { y: 2 };\n",
    });

    const names = await propertyNames(view, "app/served.ts", "served");

    expect(names).toStrictEqual(["y"]);
  });

  it("shows a dependent file the change to a module it imports", async () => {
    const schema = "export interface Velocity { dx: number; dy: number; dz: number }\n";

    const view = await session.update({ [file("app/schema.ts")]: schema });

    expect(await propertyNames(view, "app/main.ts", "v")).toStrictEqual(["dx", "dy", "dz"]);
  });

  it("gives concurrent updates each their own text and every earlier update", async () => {
    const [firstView, secondView] = await Promise.all([
      session.update({ [file("app/first.ts")]: "export const first = { x: 1, y: 2 };\n" }),
      session.update({ [file("app/second.ts")]: "export const second = { x: 1, y: 2 };\n" }),
    ]);

    expect(await propertyNames(firstView, "app/first.ts", "first")).toStrictEqual(["x", "y"]);
    expect(await propertyNames(firstView, "app/second.ts", "second")).toStrictEqual(["x"]);
    expect(await propertyNames(secondView, "app/first.ts", "first")).toStrictEqual(["x", "y"]);
    expect(await propertyNames(secondView, "app/second.ts", "second")).toStrictEqual(["x", "y"]);
  });
});

describe("Session.notifyChanged", () => {
  it("re-reads a file changed on disk at the next update", async () => {
    await propertyNames(await session.update(), "app/disk.ts", "disk");
    writeFileSync(file("app/disk.ts"), "export const disk = { z: 3 };\n");

    session.notifyChanged([file("app/disk.ts")]);
    const view = await session.update();

    expect(await propertyNames(view, "app/disk.ts", "disk")).toStrictEqual(["z"]);
  });

  it("keeps answering from the loaded text when a change on disk goes unannounced", async () => {
    await propertyNames(await session.update(), "app/unannounced.ts", "unannounced");
    writeFileSync(file("app/unannounced.ts"), "export const unannounced = { z: 3 };\n");

    const view = await session.update();

    expect(await propertyNames(view, "app/unannounced.ts", "unannounced")).toStrictEqual(["x"]);
  });
});

describe("Session.parse", () => {
  it("parses a file outside the program", async () => {
    const debug = file("node_modules/ecstatic/src/ecstatic/debug.ts");
    const view = await session.update();

    const parsed = await session.parse(debug);

    expect(parsed.fileName).toBe(debug);
    expect(parsed.text).toBe(DEBUG_SOURCE);
    expect(parsed.statements.length).toBeGreaterThan(0);
    await expect(view.sourceFile(debug)).rejects.toThrow("is not part of the project");
  });

  it.each([
    { name: "missing", rel: "node_modules/ecstatic/src/missing.ts" },
    { name: "a directory", rel: "node_modules/ecstatic/src" },
  ])("rejects naming a file it cannot read when $name", async ({ rel }) => {
    const unreadable = file(rel);

    const parsing = session.parse(unreadable);

    await expect(parsing).rejects.toThrow(unreadable);
  });
});

describe("ProjectView.emit", () => {
  it.each([
    { noEmit: true, open: () => ({ session, dir: root }) },
    { noEmit: false, open: () => ({ session: emittingSession, dir: emittingRoot }) },
  ])("emits JavaScript from the served text when noEmit is $noEmit", async ({ open }) => {
    const { session: emitting, dir } = open();
    const emitted = file("app/emitted.ts", dir);
    const view = await emitting.update({ [emitted]: "export const answer: number = 2;\n" });

    const javascript = await view.emit(emitted);

    expect(javascript).toContain("answer = 2");
    expect(javascript).not.toContain("answer = 1");
    expect(javascript).not.toContain(": number");
  });
});

describe("Session.close", () => {
  let closed: OwnSession;
  let staleView: ProjectView;

  beforeAll(async () => {
    closed = await openOwnSession();
    staleView = await closed.session.update();
    await closed.session.close();
  }, SPAWN_TIMEOUT_MS);

  it("ends the compiler process", async () => {
    await expect(waitUntilDead(closed.pid)).resolves.toBeUndefined();
  });

  it.each([
    { name: "Session.update", query: () => closed.session.update() },
    { name: "Session.parse", query: () => closed.session.parse(file("app/loaded.ts", closed.dir)) },
    {
      name: "ProjectView.sourceFile",
      query: () => staleView.sourceFile(file("app/loaded.ts", closed.dir)),
    },
    { name: "ProjectView.emit", query: () => staleView.emit(file("app/emitted.ts", closed.dir)) },
  ])("makes a later $name reject naming the closed session", async ({ query }) => {
    const querying = query();

    await expect(querying).rejects.toThrow(/closed/);
    await expect(querying).rejects.toThrow(closed.session.tsconfig);
  });

  it("is harmless a second time", async () => {
    const closing = closed.session.close();

    await expect(closing).resolves.toBeUndefined();
  });

  it.runIf(CAN_SUSPEND)(
    "settles past its deadline and ends a process that stopped answering",
    async () => {
      const { session: stalled, pid, dir } = await openOwnSession({ closeTimeoutMs: 100 });
      onTestFinished(() => {
        if (isAlive(pid)) process.kill(pid, "SIGKILL");
      });
      await stalled.parse(file("node_modules/ecstatic/src/ecstatic/debug.ts", dir));
      process.kill(pid, "SIGSTOP");

      const closing = stalled.close();

      await expect(vi.waitFor(() => closing, { timeout: 5_000 })).resolves.toBeUndefined();
      await expect(waitUntilDead(pid)).resolves.toBeUndefined();
    },
    SPAWN_TIMEOUT_MS,
  );

  it.runIf(CAN_SUSPEND)(
    "rejects a query in flight naming the exit once the deadline ends a process that stopped answering",
    async () => {
      const { session: stalled, pid, dir } = await openOwnSession({ closeTimeoutMs: 100 });
      onTestFinished(() => {
        if (isAlive(pid)) process.kill(pid, "SIGKILL");
      });
      process.kill(pid, "SIGSTOP");
      const parsing = stalled.parse(file("node_modules/ecstatic/src/ecstatic/debug.ts", dir));

      const closing = stalled.close();

      await expect(vi.waitFor(() => parsing, { timeout: 5_000 })).rejects.toThrow(/exited/);
      await expect(parsing).rejects.toThrow(stalled.tsconfig);
      await expect(closing).resolves.toBeUndefined();
    },
    SPAWN_TIMEOUT_MS,
  );
});

describe("when the compiler process exits mid-session", () => {
  it(
    "lets close settle after the process exited",
    async () => {
      const { session: crashed, pid } = await openOwnSession();
      process.kill(pid, "SIGKILL");
      await waitUntilDead(pid);

      const closing = crashed.close();

      await expect(closing).resolves.toBeUndefined();
    },
    SPAWN_TIMEOUT_MS,
  );

  it.runIf(CAN_SUSPEND)(
    "lets close settle and leaves no live process when the process exits while closing",
    async () => {
      const { session: crashed, pid } = await openOwnSession();
      onTestFinished(() => {
        if (isAlive(pid)) process.kill(pid, "SIGKILL");
      });
      process.kill(pid, "SIGSTOP");

      const closing = crashed.close();
      process.kill(pid, "SIGKILL");

      await expect(closing).resolves.toBeUndefined();
      await expect(waitUntilDead(pid)).resolves.toBeUndefined();
    },
    SPAWN_TIMEOUT_MS,
  );

  it.runIf(CAN_SUSPEND)(
    "rejects a query in flight naming the exit",
    async () => {
      const { session: crashed, pid, dir } = await openOwnSession();
      onTestFinished(async () => {
        if (isAlive(pid)) process.kill(pid, "SIGKILL");
        await crashed.close();
      });
      process.kill(pid, "SIGSTOP");

      const updating = crashed.update({
        [file("app/served.ts", dir)]: "export const served = { y: 2 };\n",
      });
      process.kill(pid, "SIGKILL");

      await expect(updating).rejects.toThrow(/exited/);
      await expect(updating).rejects.toThrow(crashed.tsconfig);
    },
    SPAWN_TIMEOUT_MS,
  );

  it(
    "rejects the next query naming the exit",
    async () => {
      const { session: crashed, pid } = await openOwnSession();
      onTestFinished(() => crashed.close());
      process.kill(pid, "SIGKILL");
      await waitUntilDead(pid);

      const updating = crashed.update();

      await expect(updating).rejects.toThrow(/exited/);
      await expect(updating).rejects.toThrow(crashed.tsconfig);
    },
    SPAWN_TIMEOUT_MS,
  );
});
