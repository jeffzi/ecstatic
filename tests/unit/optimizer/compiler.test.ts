import { join } from "node:path";

import { getTouchingPropertyName, type Node, SyntaxKind } from "typescript/ast";
import { afterAll, beforeAll, describe, expect, it, onTestFinished, vi } from "vitest";

import {
  declarationFileNames,
  foreignValueFileName,
  isAccessorProperty,
  isAccessorSymbol,
  isAnonymousObjectSymbol,
  isGlobalValue,
  nodeFileName,
  propertiesOfType,
  propertyOfType,
  refersToArguments,
  resolveSymbol,
  sourceFileName,
  symbolName,
  typeOfSymbol,
  typeSymbol,
  valueDeclaration,
} from "../../../src/plugin/optimizer/compiler.js";
import {
  openSession,
  type ProjectView,
  type Session,
} from "../../../src/plugin/optimizer/session.js";
import { appTsconfig, removeProjects, writeProject } from "./project.js";

const SCHEMA = `export interface Velocity { dx: number; dy: number }
export const origin = { x: 0 };
`;

const USES = `import { origin, type Velocity } from "./schema.js";
export declare const v: Velocity;
const local = { y: 1 };
export const fromImport = origin;
export const fromLocal = local;
const visit = 1;
export const shorthand = { visit };
export function readsArguments(): number { return arguments.length; }
export const holder = { arguments: 1 };
export const readsProperty = holder.arguments;
class Box { get size(): number { return 1; } count = 0; }
export declare const box: Box;
export const literal = { size: 1 };
export declare const shape: { w: number };
export const unresolved = missing;
`;

const GLOBALS = `export const usesMath = Math.max;
export const usesUndefined = undefined;
`;

const SHADOWS = `const Math = { max: 1 };
export const localMath = Math.max;
export function shadowsUndefined(undefined: number): number { return undefined; }
`;

let root = "";
let session: Session;
let view: ProjectView;

beforeAll(async () => {
  root = writeProject({
    "tsconfig.json": appTsconfig({ lib: ["es2024"] }),
    "app/schema.ts": SCHEMA,
    "app/uses.ts": USES,
    "app/globals.ts": GLOBALS,
    "app/shadows.ts": SHADOWS,
  });
  session = await openSession(join(root, "tsconfig.json"));
  view = await session.update();
});

afterAll(async () => {
  await session.close();
  removeProjects();
});

/** The absolute path of the project file `app/<name>`. */
function appFile(name: string): string {
  return join(root, "app", name);
}

/** The identifier `word` inside the first occurrence of `text` in `app/<name>`. */
async function identifierIn(name: string, text: string, word: string): Promise<Node> {
  const source = await view.sourceFile(appFile(name));
  const start = source.text.indexOf(text);
  if (start < 0) throw new Error(`${text} is not in ${name}`);
  return getTouchingPropertyName(source, start + text.indexOf(word));
}

/** The symbol the identifier `word` inside `text` of `app/<name>` resolves to. */
async function symbolIn(name: string, text: string, word: string) {
  const symbol = await resolveSymbol(view.checker, await identifierIn(name, text, word));
  if (symbol === undefined) throw new Error(`${word} in ${text} resolves to no symbol`);
  return symbol;
}

/** The type of the value the identifier `word` inside `text` of `app/<name>` declares or reads. */
async function typeIn(name: string, text: string, word: string) {
  return await typeOfSymbol(view.checker, await symbolIn(name, text, word));
}

/** The type of the value `uses.ts` declares as `const <name>`. */
function constType(name: string) {
  return typeIn("uses.ts", `const ${name}`, name);
}

describe("resolveSymbol", () => {
  it("follows an import to the declaring symbol", async () => {
    const symbol = await symbolIn("uses.ts", "v: Velocity", "Velocity");

    expect(symbolName(symbol)).toBe("Velocity");
    expect(await declarationFileNames(symbol)).toStrictEqual([appFile("schema.ts")]);
  });

  it("returns a local binding as declared", async () => {
    const symbol = await symbolIn("uses.ts", "fromLocal = local", "local");

    expect(symbolName(symbol)).toBe("local");
    expect(await declarationFileNames(symbol)).toStrictEqual([appFile("uses.ts")]);
  });

  it("reads the variable behind a shorthand property", async () => {
    const declared = await symbolIn("uses.ts", "const visit", "visit");

    const read = await symbolIn("uses.ts", "{ visit }", "visit");

    expect(read).toBe(declared);
  });

  it("returns undefined for a name that refers to nothing", async () => {
    const name = await identifierIn("uses.ts", "= missing", "missing");

    const symbol = await resolveSymbol(view.checker, name);

    expect(symbol).toBeUndefined();
  });

  it("returns the same object for every reference to one declaration", async () => {
    const declared = await symbolIn("uses.ts", "const local", "local");

    const read = await symbolIn("uses.ts", "fromLocal = local", "local");

    expect(read).toBe(declared);
    expect(await typeOfSymbol(view.checker, read)).toBe(await typeOfSymbol(view.checker, declared));
  });

  it("keys a Map by the symbol and the type of one declaration", async () => {
    const declared = await symbolIn("uses.ts", "const local", "local");
    const symbols = new Map([[declared, "local"]]);
    const types = new Map([[await typeOfSymbol(view.checker, declared), "local"]]);

    const read = await symbolIn("uses.ts", "fromLocal = local", "local");

    expect(symbols.get(read)).toBe("local");
    expect(types.get(await typeOfSymbol(view.checker, read))).toBe("local");
  });
});

describe("foreignValueFileName", () => {
  it("names the file declaring an imported value", async () => {
    const expr = await identifierIn("uses.ts", "fromImport = origin", "origin");

    const fileName = await foreignValueFileName(view.checker, expr);

    expect(fileName).toBe(appFile("schema.ts"));
  });

  it.each([
    { reference: "a local value", text: "fromLocal = local", word: "local" },
    { reference: "a type with no value", text: "v: Velocity", word: "Velocity" },
    { reference: "an undeclared name", text: "= missing", word: "missing" },
  ])("returns undefined for $reference", async ({ text, word }) => {
    const expr = await identifierIn("uses.ts", text, word);

    const fileName = await foreignValueFileName(view.checker, expr);

    expect(fileName).toBeUndefined();
  });
});

describe("refersToArguments", () => {
  it.each([
    { reference: "a function's arguments object", text: "return arguments", expected: true },
    { reference: "a property named arguments", text: "holder.arguments", expected: false },
  ])("is $expected for $reference", async ({ text, expected }) => {
    const name = await identifierIn("uses.ts", text, "arguments");

    const actual = await refersToArguments(view.checker, name);

    expect(actual).toBe(expected);
  });
});

describe("valueDeclaration", () => {
  it("returns the declaration of a value", async () => {
    const symbol = await symbolIn("uses.ts", "const local", "local");

    const declaration = await valueDeclaration(symbol);

    expect(declaration?.kind).toBe(SyntaxKind.VariableDeclaration);
    expect(declaration?.getText()).toBe("local = { y: 1 }");
  });

  it("returns undefined for a type", async () => {
    const symbol = await symbolIn("uses.ts", "v: Velocity", "Velocity");

    const declaration = await valueDeclaration(symbol);

    expect(declaration).toBeUndefined();
  });
});

describe("file names", () => {
  it("names a source file and a node by the file's path", async () => {
    const source = await view.sourceFile(appFile("uses.ts"));
    const node = await identifierIn("uses.ts", "const local", "local");

    expect(sourceFileName(source)).toBe(appFile("uses.ts"));
    expect(nodeFileName(node)).toBe(appFile("uses.ts"));
  });

  it("lists no declaration files for no symbol", async () => {
    const names = await declarationFileNames(undefined);

    expect(names).toStrictEqual([]);
  });
});

describe("type queries", () => {
  it("lists a type's properties in declaration order", async () => {
    const type = await constType("v");

    const names = (await propertiesOfType(view.checker, type)).map(symbolName);

    expect(names).toStrictEqual(["dx", "dy"]);
  });

  it.each([
    { name: "dx", expected: "dx" },
    { name: "dz", expected: undefined },
  ])("finds property $name as $expected", async ({ name, expected }) => {
    const type = await constType("v");

    const property = await propertyOfType(view.checker, type, name);

    expect(property === undefined ? undefined : symbolName(property)).toBe(expected);
  });

  it.each([
    { value: "box", expected: "Box" },
    { value: "readsProperty", expected: undefined },
  ])("names the symbol behind the type of $value as $expected", async ({ value, expected }) => {
    const type = await constType(value);

    const symbol = await typeSymbol(type);

    expect(symbol === undefined ? undefined : symbolName(symbol)).toBe(expected);
  });

  it.each([
    { name: "size", expected: true },
    { name: "count", expected: false },
    { name: "absent", expected: false },
  ])("reports whether property $name is an accessor: $expected", async ({ name, expected }) => {
    const type = await constType("box");

    const actual = await isAccessorProperty(view.checker, type, name);

    expect(actual).toBe(expected);
  });

  it("reports no symbol as no accessor", () => {
    expect(isAccessorSymbol(undefined)).toBe(false);
  });

  it.each([
    { value: "literal", expected: true },
    { value: "shape", expected: true },
    { value: "box", expected: false },
  ])("reports the type of $value as anonymous: $expected", async ({ value, expected }) => {
    const symbol = await typeSymbol(await constType(value));

    const actual = isAnonymousObjectSymbol(symbol);

    expect(actual).toBe(expected);
  });

  it("reports a type with no symbol as anonymous", () => {
    expect(isAnonymousObjectSymbol(undefined)).toBe(true);
  });
});

describe("isGlobalValue", () => {
  it.each([
    {
      reference: "the global Math",
      file: "globals.ts",
      text: "= Math",
      word: "Math",
      name: "Math",
      expected: true,
    },
    {
      reference: "the global undefined",
      file: "globals.ts",
      text: "= undefined",
      word: "undefined",
      name: "undefined",
      expected: true,
    },
    {
      reference: "a local Math",
      file: "shadows.ts",
      text: "= Math",
      word: "Math",
      name: "Math",
      expected: false,
    },
    {
      reference: "a parameter named undefined",
      file: "shadows.ts",
      text: "return undefined",
      word: "undefined",
      name: "undefined",
      expected: false,
    },
    {
      reference: "an identifier with another name",
      file: "globals.ts",
      text: "= Math",
      word: "Math",
      name: "undefined",
      expected: false,
    },
  ])("is $expected for $reference", async ({ file, text, word, name, expected }) => {
    const expr = await identifierIn(file, text, word);

    const actual = await isGlobalValue(view.checker, expr, name);

    expect(actual).toBe(expected);
  });

  it("is false for an expression other than an identifier", async () => {
    const access = (await identifierIn("globals.ts", "Math.max", "max")).parent;

    const actual = await isGlobalValue(view.checker, access, "Math");

    expect(actual).toBe(false);
  });
});

interface FakeInput {
  write?: (...args: unknown[]) => boolean;
}

interface FakeClient {
  connect?: () => Promise<void>;
  connection?: { onClose?: () => void; dispose?: () => void };
  process?: {
    kill?: (signal: string) => boolean;
    once?: (event: string, listener: () => void) => void;
    stdin?: FakeInput;
  };
  apiRequest?: (method: string, params: unknown) => Promise<undefined>;
  close?: () => Promise<void>;
}

interface FakeApiMembers {
  client?: FakeClient;
}

/**
 * Imports `compiler.ts` against a fake `API` whose internals are complete except what `customize`
 * removes or replaces. Like the real one, the fake's `close` releases a remote object through the
 * client before closing it.
 */
async function importWithFakeApi(customize: (members: FakeApiMembers) => void): Promise<{
  compiler: typeof import("../../../src/plugin/optimizer/compiler.js");
  created: { close: ReturnType<typeof vi.fn> }[];
}> {
  const created: { close: ReturnType<typeof vi.fn> }[] = [];
  vi.resetModules();
  vi.doMock("typescript/async", async (importOriginal) => ({
    ...(await importOriginal<typeof import("typescript/async")>()),
    API: class {
      readonly client: FakeClient | undefined;

      readonly close = vi.fn(async () => {
        await this.client?.apiRequest?.("release", "snapshot");
        if (this.client?.close === undefined) {
          throw new TypeError("Cannot read properties of undefined (reading 'close')");
        }
        await this.client.close();
      });

      constructor() {
        const members: FakeApiMembers = {
          client: {
            connect: async () => {},
            connection: { onClose: () => {}, dispose: () => {} },
            process: { kill: () => true, once: () => {}, stdin: { write: () => true } },
            apiRequest: async () => undefined,
            close: async () => {},
          },
        };
        customize(members);
        this.client = members.client;
        created.push(this);
      }
    },
  }));
  onTestFinished(() => {
    vi.doUnmock("typescript/async");
    vi.resetModules();
  });
  const compiler = await import("../../../src/plugin/optimizer/compiler.js");
  return { compiler, created };
}

describe("startCompiler", () => {
  describe("when the compiler API lacks an internal member", () => {
    it.each<{ member: string; strip: (members: FakeApiMembers) => void }>([
      { member: "client", strip: (m) => delete m.client },
      { member: "client.connect", strip: (m) => delete m.client?.connect },
      { member: "client.close", strip: (m) => delete m.client?.close },
      { member: "client.apiRequest", strip: (m) => delete m.client?.apiRequest },
      { member: "client.connection", strip: (m) => delete m.client?.connection },
      { member: "client.connection.onClose", strip: (m) => delete m.client?.connection?.onClose },
      { member: "client.connection.dispose", strip: (m) => delete m.client?.connection?.dispose },
      { member: "client.process", strip: (m) => delete m.client?.process },
      { member: "client.process.kill", strip: (m) => delete m.client?.process?.kill },
      { member: "client.process.once", strip: (m) => delete m.client?.process?.once },
      { member: "client.process.stdin", strip: (m) => delete m.client?.process?.stdin },
      {
        member: "client.process.stdin.write",
        strip: (m) => delete m.client?.process?.stdin?.write,
      },
    ])("rejects naming $member", async ({ member, strip }) => {
      const {
        compiler: { startCompiler },
      } = await importWithFakeApi(strip);

      const starting = startCompiler(undefined);

      await expect(starting).rejects.toThrow(
        `the compiler API no longer holds the ${member} this optimizer relies on`,
      );
    });

    it("closes the API it created even when that close fails", async () => {
      const {
        compiler: { startCompiler },
        created,
      } = await importWithFakeApi((m) => delete m.client?.close);

      await startCompiler(undefined).catch(() => {});

      expect(created).toHaveLength(1);
      expect(created[0]?.close).toHaveBeenCalledOnce();
    });
  });

  it("turns a failed write to the process input into the process's exit", async () => {
    const kill = vi.fn((_signal: string) => true);
    const dispose = vi.fn();
    const written = vi.fn();
    let stdin: FakeInput | undefined;
    const {
      compiler: { startCompiler },
    } = await importWithFakeApi((m) => {
      stdin = {
        write: (...args: unknown[]) => {
          const callback = args.at(-1);
          if (typeof callback === "function") callback(new Error("write EPIPE"));
          return false;
        },
      };
      m.client = {
        ...m.client,
        connection: { onClose: () => {}, dispose },
        process: { kill, once: () => {}, stdin },
      };
    });
    const compiler = await startCompiler(undefined);

    stdin?.write?.("request", written);

    expect(written).toHaveBeenCalledExactlyOnceWith();
    expect(kill).toHaveBeenCalledWith("SIGKILL");
    expect(dispose).toHaveBeenCalled();
    expect(compiler.exited).toBe(true);
  });
});

describe("closeCompiler", () => {
  it("rejects with the close failure while the process is still running", async () => {
    const {
      compiler: { closeCompiler, startCompiler },
    } = await importWithFakeApi((m) => {
      m.client = {
        ...m.client,
        close: async () => {
          throw new Error("close refused");
        },
      };
    });
    const compiler = await startCompiler(undefined);

    const closing = closeCompiler(compiler, 60_000);

    await expect(closing).rejects.toThrow("close refused");
  });

  it("sends no request to the process while closing", async () => {
    const apiRequest = vi.fn(async (_method: string, _params: unknown) => undefined);
    let exit = (): void => {};
    const {
      compiler: { closeCompiler, startCompiler },
    } = await importWithFakeApi((m) => {
      m.client = {
        ...m.client,
        apiRequest,
        process: {
          kill: () => true,
          once: (_event, listener) => {
            exit = listener;
          },
          stdin: { write: () => true },
        },
        close: async () => {
          exit();
        },
      };
    });
    const compiler = await startCompiler(undefined);

    await closeCompiler(compiler, 60_000);

    expect(apiRequest).not.toHaveBeenCalled();
  });
});
