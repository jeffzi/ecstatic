import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { getTouchingPropertyName, type Node, type SourceFile } from "typescript/ast";
import { afterAll, beforeAll, describe, expect, it, onTestFinished, vi } from "vitest";

import {
  propertiesOfType,
  resolveSymbol,
  sourceFileName,
  symbolName,
  typeOfSymbol,
} from "../../../src/plugin/optimizer/compiler.js";
import {
  openSession,
  type ProjectView,
  type Session,
  SessionEndedError,
  type SessionOptions,
} from "../../../src/plugin/optimizer/session.js";
import { isAlive, processesStartedSince, runningProcesses, waitUntilDead } from "./processes.js";
import {
  appTsconfig,
  killCompiler,
  removeProjects,
  runtimeProject,
  writeProject,
} from "./project.js";

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
  "app/removed.ts": "export const removed = { x: 1 };\n",
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

/** The identifier of the value declared as `const name` in `source`. */
function declaredName(source: SourceFile, name: string): Node {
  return getTouchingPropertyName(source, source.text.indexOf(`const ${name}`) + 6);
}

/** The property names of the type of the value declared as `name` in `rel`, as `view`'s checker sees it. */
async function propertyNames(view: ProjectView, rel: string, name: string): Promise<string[]> {
  const identifier = declaredName(await view.sourceFile(file(rel)), name);
  const symbol = await resolveSymbol(view.checker, identifier);
  if (symbol === undefined) throw new Error(`${name} resolves to no symbol in ${rel}`);
  const type = await typeOfSymbol(view.checker, symbol);
  return (await propertiesOfType(view.checker, type)).map(symbolName);
}

/**
 * Kills `pid` and blocks until the kernel has ended it, so the event loop has not yet seen the exit
 * or the closed pipes when this returns.
 */
function killUnobserved(pid: number): void {
  process.kill(pid, "SIGKILL");
  const pause = new Int32Array(new SharedArrayBuffer(4));
  const deadline = Date.now() + 5_000;
  while (processState(pid)?.startsWith("Z") === false) {
    if (Date.now() > deadline) throw new Error(`process ${pid} outlived SIGKILL`);
    Atomics.wait(pause, 0, 0, 5);
  }
}

/** The `ps` state code of `pid`, or undefined once the process is gone. */
function processState(pid: number): string | undefined {
  try {
    return execFileSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" }).trim();
  } catch {
    return undefined;
  }
}

/** Records every unhandled rejection until the current test finishes. */
function collectUnhandledRejections(): unknown[] {
  const reasons: unknown[] = [];
  const record = (reason: unknown): void => {
    reasons.push(reason);
  };
  process.on("unhandledRejection", record);
  onTestFinished(() => {
    process.off("unhandledRejection", record);
  });
  return reasons;
}

interface OwnSession {
  readonly session: Session;
  readonly pid: number;
  readonly dir: string;
}

/** Opens a session on a fresh copy of the shared project and returns it with its compiler's process ID and directory. */
async function openOwnSession(options: SessionOptions = {}): Promise<OwnSession> {
  const before = await runningProcesses();
  const dir = writeProject(PROJECT);
  const own = await openSession(join(dir, "tsconfig.json"), options);
  const started = await processesStartedSince(before);
  const [pid] = started;
  if (started.length !== 1 || pid === undefined) {
    throw new Error(`expected one new compiler process, found ${started.length}`);
  }
  return { session: own, pid, dir };
}

/** Kills `pid` with SIGKILL when the current test finishes, if it is still running. */
function killWhenTestFinishes(pid: number): void {
  onTestFinished(() => {
    if (isAlive(pid)) process.kill(pid, "SIGKILL");
  });
}

/** Whether this platform can suspend a process, so a test can hold its requests unanswered. */
const CAN_SUSPEND = process.platform !== "win32";

/** How long a suspended process is given to receive the pending work before it is killed. */
const SUSPENDED_SETTLE_MS = 50;

/** How long a case waits after the process dies for a stray unhandled rejection to surface. */
const UNHANDLED_REJECTION_WINDOW_MS = 100;

/** Sends `target` an update that serves new text for `app/served.ts` under `dir`. */
function updateServed(target: Session, dir: string): Promise<ProjectView> {
  return target.update({ [file("app/served.ts", dir)]: "export const served = { y: 2 };\n" });
}

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

  it("treats a file it removes as missing, even one it served", async () => {
    const removed = file("app/removed.ts");
    await session.update({ [removed]: "export const removed = { y: 2 };\n" });

    const view = await session.update({}, [removed]);

    await expect(view.sourceFile(removed)).rejects.toThrow(`${removed} is not part of the project`);
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

    expect(sourceFileName(parsed)).toBe(debug);
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

describe("ProjectView.endedError", () => {
  it("answers undefined for a failure on a live session", async () => {
    const view = await session.update();

    const ended = view.endedError(new Error("banana split"));

    expect(ended).toBeUndefined();
  });

  it("answers a session error it is given with that error", async () => {
    const view = await session.update();
    const given = new SessionEndedError("banana split");

    const ended = view.endedError(given);

    expect(ended).toBe(given);
  });
});

describe("Session.close", () => {
  let closed: OwnSession;
  let staleView: ProjectView;
  let staleName: Node;

  beforeAll(async () => {
    closed = await openOwnSession();
    staleView = await closed.session.update();
    staleName = declaredName(
      await staleView.sourceFile(file("app/loaded.ts", closed.dir)),
      "loaded",
    );
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
    { name: "ProjectView.checker query", query: () => resolveSymbol(staleView.checker, staleName) },
    {
      name: "direct ProjectView.checker call",
      query: () => staleView.checker.getSymbolAtLocation(staleName),
    },
  ])("makes a later $name reject naming the closed session", async ({ query }) => {
    const querying = query();

    await expect(querying).rejects.toBeInstanceOf(SessionEndedError);
    await expect(querying).rejects.toThrow(/closed/);
    await expect(querying).rejects.toThrow(closed.session.tsconfig);
  });

  it("names a failure through an earlier view as the closed session's", () => {
    const failure = new Error("banana split");

    const ended = staleView.endedError(failure);

    expect(ended).toBeInstanceOf(SessionEndedError);
    expect(ended?.message).toMatch(/closed/);
    expect(ended?.message).toContain(closed.session.tsconfig);
  });

  it("is harmless a second time", async () => {
    const closing = closed.session.close();

    await expect(closing).resolves.toBeUndefined();
  });

  it.runIf(CAN_SUSPEND)(
    "settles past its deadline and ends a process that stopped answering",
    async () => {
      const { session: stalled, pid, dir } = await openOwnSession({ closeTimeoutMs: 100 });
      killWhenTestFinishes(pid);
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
      killWhenTestFinishes(pid);
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

  it.runIf(CAN_SUSPEND).each([
    {
      moment: "before the close starts",
      close: (crashed: Session, pid: number) => {
        killUnobserved(pid);
        return crashed.close();
      },
    },
    {
      moment: "as the close starts",
      close: (crashed: Session, pid: number) => {
        const closing = crashed.close();
        killUnobserved(pid);
        return closing;
      },
    },
    {
      moment: "while the close waits on a suspended process",
      close: async (crashed: Session, pid: number) => {
        process.kill(pid, "SIGSTOP");
        const closing = crashed.close();
        await delay(SUSPENDED_SETTLE_MS);
        process.kill(pid, "SIGKILL");
        await closing;
      },
    },
  ])(
    "lets close settle cleanly when the process dies $moment",
    async ({ close }) => {
      const { session: crashed, pid } = await openOwnSession();
      killWhenTestFinishes(pid);
      const unhandled = collectUnhandledRejections();

      const closing = close(crashed, pid);

      await expect(closing).resolves.toBeUndefined();
      await expect(waitUntilDead(pid)).resolves.toBeUndefined();
      await delay(UNHANDLED_REJECTION_WINDOW_MS);
      expect(unhandled).toStrictEqual([]);
    },
    SPAWN_TIMEOUT_MS,
  );

  it.runIf(CAN_SUSPEND).each([
    {
      moment: "before the query reaches the process",
      query: (crashed: Session, pid: number, dir: string) => {
        const updating = updateServed(crashed, dir);
        killUnobserved(pid);
        return updating;
      },
    },
    {
      moment: "after the query reached the suspended process",
      query: async (crashed: Session, pid: number, dir: string) => {
        process.kill(pid, "SIGSTOP");
        const updating = updateServed(crashed, dir);
        await delay(SUSPENDED_SETTLE_MS);
        process.kill(pid, "SIGKILL");
        return updating;
      },
    },
  ])(
    "rejects a query in flight naming the exit when the process dies $moment",
    async ({ query }) => {
      const { session: crashed, pid, dir } = await openOwnSession();
      onTestFinished(async () => {
        if (isAlive(pid)) process.kill(pid, "SIGKILL");
        await crashed.close();
      });
      const unhandled = collectUnhandledRejections();

      const updating = query(crashed, pid, dir);

      await expect(updating).rejects.toThrow(/exited/);
      await expect(updating).rejects.toThrow(crashed.tsconfig);
      await delay(UNHANDLED_REJECTION_WINDOW_MS);
      expect(unhandled).toStrictEqual([]);
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

  it(
    "rejects a checker query through an earlier view naming the exit, with the original error as its cause",
    async () => {
      const { session: crashed, pid, dir } = await openOwnSession();
      onTestFinished(() => crashed.close());
      const view = await crashed.update();
      const name = declaredName(await view.sourceFile(file("app/loaded.ts", dir)), "loaded");
      process.kill(pid, "SIGKILL");
      await waitUntilDead(pid);

      const resolving = resolveSymbol(view.checker, name);

      await expect(resolving).rejects.toBeInstanceOf(SessionEndedError);
      await expect(resolving).rejects.toThrow(/exited/);
      await expect(resolving).rejects.toThrow(crashed.tsconfig);
      await expect(resolving).rejects.toHaveProperty("cause", expect.any(Error));
    },
    SPAWN_TIMEOUT_MS,
  );

  it(
    "names a failure through an earlier view as the exit, carrying that failure as its cause",
    async () => {
      const { session: crashed, pid } = await openOwnSession();
      onTestFinished(() => crashed.close());
      const view = await crashed.update();
      await killCompiler(crashed, pid);
      const failure = new Error("banana split");

      const ended = view.endedError(failure);

      expect(ended).toBeInstanceOf(SessionEndedError);
      expect(ended?.message).toMatch(/exited/);
      expect(ended?.message).toContain(crashed.tsconfig);
      expect(ended?.cause).toBe(failure);
    },
    SPAWN_TIMEOUT_MS,
  );
});
