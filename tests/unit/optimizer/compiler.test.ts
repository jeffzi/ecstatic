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

describe("startCompiler", () => {
  it("rejects naming the missing member and closes the API it created when the API lacks its client", async () => {
    const created: { close: ReturnType<typeof vi.fn> }[] = [];
    vi.resetModules();
    vi.doMock("typescript/async", async (importOriginal) => ({
      ...(await importOriginal<typeof import("typescript/async")>()),
      API: class {
        readonly close = vi.fn(async () => {});

        constructor() {
          created.push(this);
        }
      },
    }));
    onTestFinished(() => {
      vi.doUnmock("typescript/async");
      vi.resetModules();
    });
    const { startCompiler } = await import("../../../src/plugin/optimizer/compiler.js");

    const starting = startCompiler(undefined);

    await expect(starting).rejects.toThrow(
      "the compiler API no longer holds the client this optimizer relies on",
    );
    expect(created).toHaveLength(1);
    expect(created[0]?.close).toHaveBeenCalledOnce();
  });
});

describe("closeCompiler", () => {
  it("rejects with the close failure while the process is still running", async () => {
    vi.resetModules();
    vi.doMock("typescript/async", async (importOriginal) => ({
      ...(await importOriginal<typeof import("typescript/async")>()),
      API: class {
        readonly client = {
          connect: async () => {},
          connection: { onClose: () => {}, dispose: () => {} },
          process: { kill: () => true },
        };

        async close(): Promise<void> {
          throw new Error("release refused");
        }
      },
    }));
    onTestFinished(() => {
      vi.doUnmock("typescript/async");
      vi.resetModules();
    });
    const { closeCompiler, startCompiler } =
      await import("../../../src/plugin/optimizer/compiler.js");
    const compiler = await startCompiler(undefined);

    const closing = closeCompiler(compiler, 60_000);

    await expect(closing).rejects.toThrow("release refused");
  });
});
