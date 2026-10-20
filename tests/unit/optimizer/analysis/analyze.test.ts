import { setTimeout as delay } from "node:timers/promises";

import type { SourceFile } from "typescript/ast";
import { isCallExpression } from "typescript/ast/is";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { analyze } from "../../../../src/plugin/optimizer/analysis/analyze.js";
import { PackageRoots } from "../../../../src/plugin/optimizer/analysis/roots.js";
import type { Checker } from "../../../../src/plugin/optimizer/compiler.js";
import type { Op, Reason, Site } from "../../../../src/plugin/optimizer/facts.js";
import type { NodeTable } from "../../../../src/plugin/optimizer/nodes.js";
import type { ProjectView, Session } from "../../../../src/plugin/optimizer/session.js";
import { locate } from "../locate.js";
import {
  closeProject,
  openProject,
  projectPath,
  runtimeProject,
  SPAWN_TIMEOUT_MS,
  writeProject,
} from "../project.js";

const ECSTATIC_MANIFEST = `{"name": "ecstatic"}`;
const OTHER_MANIFEST = `{"name": "other"}`;

/** Declares the iteration ops of the installed ecstatic. */
const ITERATION_DECLARATIONS = `export interface Storage { readonly size: number }
export declare function each(storage: Storage, callback: (entity: number) => void): void;
export declare function each(storage: Storage, filter: unknown, callback: (entity: number) => void): void;
export declare function query(world: unknown, filter: unknown, callback: (entity: number) => void): void;
`;

/** Declares entity ops of the installed ecstatic, and `banana`, an export that is no op. */
const ENTITY_DECLARATIONS = `export declare function has(entity: number, component: unknown): boolean;
export declare function spawn(world: unknown, ...components: unknown[]): number;
export declare function get(entity: number, component: unknown): unknown;
export declare function banana(): void;
`;

const INDEX_DECLARATIONS = `export { each, query } from "./iteration.js";
export type { Storage } from "./iteration.js";
export { has, spawn, get, banana } from "./entity.js";
`;

/** An unrelated package, installed at `dir`, exporting a function named like an ecstatic op. */
function otherPackage(dir: string): Record<string, string> {
  return {
    [`${dir}/package.json`]: `{"name": "other", "type": "module", "types": "index.d.ts"}`,
    [`${dir}/index.d.ts`]:
      "export declare function each(storage: unknown, callback: () => void): void;\n",
  };
}

/** The file of an app that installs ecstatic as a dependency, beside an unrelated package. */
const INSTALLED_MAIN = "installed/app/main.ts";

/** The user module of the installed app that re-exports ecstatic. */
const INSTALLED_REEXPORT = "installed/app/reexport.ts";

/** A case file of the project's own runtime, the one under `src/ecstatic/`. */
const RUNTIME_CASE = "app/runtime-case.ts";

/** Opens every runtime case file: the runtime API and the shared archetypes. */
const RUNTIME_PRELUDE = `import { createWorld, each, register, type Storage } from "../src/ecstatic/index.js";
import { Enemy, Position, Ship } from "./ecs.js";
`;

const ECS_SOURCE = `import { Archetype, archetype, component } from "../src/ecstatic/index.js";

export const Position = component("Position", { x: 0, y: 0 });
export const Velocity = component("Velocity", { dx: 0, dy: 0 });
export const Stunned = component("Stunned");
export const Enemy = archetype([Position, Velocity], [Stunned]);
export class Ship extends Archetype([Position], [Stunned]) {}
`;

const OTHER_EACH_SOURCE = `import { each } from "other";
each(1, () => {});
`;

/** A runtime module calling `each` imported from `specifier`. */
function runtimeCall(specifier: string): string {
  return `import { each } from "${specifier}";\neach(1, async (e) => {});\n`;
}

/**
 * Builds the project every analysis case runs in.
 *
 * @returns The project files: the runtime under `src/ecstatic/` beside a manifest named
 *   `ecstatic`, an app under `installed/` that installs a declared ecstatic, and under
 *   `repository/` a repository whose own runtime sits in `src/` and `dist/`.
 */
function analysisProject(): Record<string, string> {
  return runtimeProject({
    "app/ecs.ts": ECS_SOURCE,
    [RUNTIME_CASE]: "export {};\n",
    "installed/node_modules/ecstatic/package.json": `{"name": "ecstatic", "type": "module", "types": "dist/index.d.ts"}`,
    "installed/node_modules/ecstatic/dist/index.d.ts": INDEX_DECLARATIONS,
    "installed/node_modules/ecstatic/dist/iteration.d.ts": ITERATION_DECLARATIONS,
    "installed/node_modules/ecstatic/dist/entity.d.ts": ENTITY_DECLARATIONS,
    ...otherPackage("installed/node_modules/other"),
    [INSTALLED_MAIN]: "export {};\n",
    [INSTALLED_REEXPORT]: "export {};\n",
    "repository/package.json": `{"name": "ecstatic", "type": "module"}`,
    "repository/src/index.ts": 'export { each } from "./iteration.js";\n',
    "repository/src/iteration.ts": `export function each(storage: unknown, callback: (entity: number) => void): void {
  callback(storage === undefined ? 0 : 1);
}
`,
    "repository/dist/iteration.ts": 'export { each } from "../src/iteration.js";\n',
    ...otherPackage("repository/node_modules/other"),
    "repository/app/main.ts": OTHER_EACH_SOURCE,
    "repository/tests/each.test.ts":
      'import { each } from "../src/index.js";\neach(1, () => {});\n',
    "repository/src/system.ts": runtimeCall("./iteration.js"),
    "repository/dist/system.ts": runtimeCall("./iteration.js"),
    "repository/src/entity/system.ts": runtimeCall("../iteration.js"),
    "repository/dist/entity/system.ts": runtimeCall("../iteration.js"),
  });
}

let root = "";
let session: Session;

beforeAll(async () => {
  ({ root, session } = await openProject(analysisProject()));
}, SPAWN_TIMEOUT_MS);

afterAll(() => closeProject(session));

/** A file served through the shared session, with the view that serves it. */
interface Served {
  readonly view: ProjectView;
  readonly file: SourceFile;
}

/** Serves `texts`, keyed by project-relative path, and gives the file at `rel`. */
async function serve(rel: string, texts: Readonly<Record<string, string>> = {}): Promise<Served> {
  const view = await session.update(
    Object.fromEntries(
      Object.entries(texts).map(([path, text]) => [projectPath(root, path), text]),
    ),
  );
  return { view, file: await view.sourceFile(projectPath(root, rel)) };
}

/** The sites and node table of the file at `rel` once `texts` are served, with the file. */
async function analyzeServed(
  rel: string,
  texts: Readonly<Record<string, string>> = {},
): Promise<{
  readonly sites: readonly Site[];
  readonly table: NodeTable;
  readonly file: SourceFile;
}> {
  const { view, file } = await serve(rel, texts);
  const { sites, table } = await analyze(view.checker, file, new PackageRoots());
  return { sites, table, file };
}

/** The sites of the installed app's main file holding `source`. */
async function installedSites(source: string): Promise<readonly Site[]> {
  const { sites } = await analyzeServed(INSTALLED_MAIN, { [INSTALLED_MAIN]: source });
  return sites;
}

/** The text of an installed-app main file: `imports`, a declared storage `s`, then `calls`. */
function installedMain(imports: string, calls: string): string {
  return `${imports}\ndeclare const s: any;\n${calls}\n`;
}

/** A case whose main file of the installed app holds `main`, served beside the `extra` files. */
function installedCase(
  main: string,
  extra: Readonly<Record<string, string>> = {},
): { file: string; texts: Record<string, string> } {
  return { file: INSTALLED_MAIN, texts: { ...extra, [INSTALLED_MAIN]: main } };
}

/**
 * `checker` with the answer of its `n`th query held back by the `n`th of `delays` milliseconds,
 * cycling, so concurrent queries settle in an order the delays choose.
 */
function delayedChecker(checker: Checker, delays: readonly number[]): Checker {
  let calls = 0;
  return new Proxy(checker, {
    get(target, property) {
      const member: unknown = Reflect.get(target, property, target);
      if (typeof member !== "function") return member;
      return (...args: unknown[]): unknown => {
        const answer: unknown = Reflect.apply(member, target, args);
        if (!(answer instanceof Promise)) return answer;
        const wait = delays[calls++ % delays.length] ?? 0;
        return answer.then(async (value: unknown) => {
          await delay(wait);
          return value;
        });
      };
    },
  });
}

/** A site reduced to its op and nesting. */
interface SiteSummary {
  readonly op: Op;
  readonly nested: readonly SiteSummary[];
}

/** Reduces `sites` to their ops and nesting. */
function summarize(sites: readonly Site[]): SiteSummary[] {
  return sites.map(({ op, nested }) => ({ op, nested: summarize(nested) }));
}

/** Lists `sites` depth-first, each before its nested sites. */
function flatten(sites: readonly Site[]): Site[] {
  return sites.flatMap((site) => [site, ...flatten(site.nested)]);
}

describe("analyze", () => {
  it("records the statement context of a call in each expression position", async () => {
    const sites = await installedSites(`import { each } from "ecstatic";
declare const s: any;
declare const x: boolean;
each(s, () => {});
const viaArrow = (v: any) => each(v, () => {});
x && each(s, () => {});
function viaReturn() {
  return each(s, () => {});
}
(each(s, () => {}));
void each(s, () => {});
const kept = each(s, () => {});
String(each(s, () => {}));
const viaParenthesizedArrow = (v: any) => (each(v, () => {}));
`);

    expect(sites.map(({ context }) => context)).toStrictEqual([
      "expression-statement",
      "arrow-body",
      "other-expression",
      "other-expression",
      "other-expression",
      "other-expression",
      "other-expression",
      "other-expression",
      "other-expression",
    ]);
  });

  it.each<{ name: string; call: string; typeError?: string; expected: Reason[] }>([
    {
      name: "each with too few arguments",
      call: "each(s)",
      typeError: "each takes two or three arguments",
      expected: ["ARG_COUNT"],
    },
    {
      name: "each with four arguments",
      call: "each(s, {}, () => {}, 1)",
      typeError: "each takes two or three arguments",
      expected: ["ARG_COUNT"],
    },
    {
      name: "query with two arguments",
      call: "query(s, () => {})",
      typeError: "query takes three arguments",
      expected: ["ARG_COUNT"],
    },
    { name: "query with three arguments", call: "query(s, [], () => {})", expected: [] },
    {
      name: "another op with any count",
      call: "has(1)",
      typeError: "has takes two arguments",
      expected: [],
    },
  ])("records an argument count mismatch only for iteration ops: $name", async (row) => {
    const directive =
      row.typeError === undefined ? "" : `// @ts-expect-error -- ${row.typeError}\n`;

    const sites = await installedSites(
      installedMain('import { each, query, has } from "ecstatic";', `${directive}${row.call};`),
    );

    expect(sites.map(({ reasons }) => reasons)).toStrictEqual([row.expected]);
  });

  describe("when a callback holds ecstatic calls", () => {
    const source = `import { each, query, has, spawn, get } from "ecstatic";
declare const s: any;
each(s, (e) => {
  has(e, s);
  each(s, (f) => {
    get(f, s);
  });
  const shown = spawn(s);
  // @ts-expect-error -- each takes two or three arguments; this site records ARG_COUNT
  each(s);
});
query(s, [], (e) => has(e, s));
`;

    it("reports them as the nested sites of its call", async () => {
      const sites = await installedSites(source);

      expect(summarize(sites)).toStrictEqual([
        {
          op: "each",
          nested: [
            { op: "has", nested: [] },
            { op: "each", nested: [{ op: "get", nested: [] }] },
            { op: "spawn", nested: [] },
            { op: "each", nested: [] },
          ],
        },
        { op: "query", nested: [{ op: "has", nested: [] }] },
      ]);
    });

    it("registers each site's call expression, depth-first", async () => {
      const starts: [string, number][] = [
        ["each(s, (e) =>", 0],
        ["has(e, s)", 0],
        ["each(s, (f) =>", 0],
        ["get(f, s)", 0],
        ["spawn(s)", 0],
        ["each(s);", 0],
        ["query(s, [], (e) =>", 0],
        ["has(e, s)", 1],
      ];

      const { sites, table, file } = await analyzeServed(INSTALLED_MAIN, {
        [INSTALLED_MAIN]: source,
      });

      const calls = flatten(sites).map(({ call }) => {
        const node = table.node(call);
        return { call: node !== undefined && isCallExpression(node), start: node?.getStart() };
      });
      expect(calls).toStrictEqual(
        starts.map(([text, nth]) => ({
          call: true,
          start: locate(file.fileName, source, text, nth).offset,
        })),
      );
    });
  });

  it("counts the column of a call after non-ASCII text on its line in UTF-16 code units", async () => {
    const source = `import { has } from "ecstatic";
declare const s: any;
const label = "é🚀"; has(s, s);
`;

    const { sites, file } = await analyzeServed(INSTALLED_MAIN, { [INSTALLED_MAIN]: source });

    expect(sites.map(({ pos }) => pos)).toStrictEqual([locate(file.fileName, source, "has(s, s)")]);
  });

  it("returns equal sites when run twice with one root cache, whatever order its queries settle in", async () => {
    const { view, file } = await serve(RUNTIME_CASE, {
      [RUNTIME_CASE]: `${RUNTIME_PRELUDE}declare const s: Storage<Ship>;
declare function visit(value: unknown): void;
each(s, (e) => {
  e.Position.x += e.Position.y;
  visit(e);
  each(s, (f) => {
    f.Position.y = e.Position.x;
    if (f.id === e.id) return;
    visit(f.Position);
  });
  return;
});
each(s, (e) => {
  var count = e.Position.x;
  visit(count);
});
`,
    });
    const roots = new PackageRoots();
    const first = await analyze(delayedChecker(view.checker, [0, 4, 8, 12]), file, roots);

    const second = await analyze(delayedChecker(view.checker, [12, 8, 4, 0]), file, roots);

    expect(second.sites).toStrictEqual(first.sites);
  });

  it("lists the declaration files a resolved site's shape consulted", async () => {
    const { view, file } = await serve(RUNTIME_CASE, {
      [RUNTIME_CASE]: `${RUNTIME_PRELUDE}declare const s: Storage<Ship>;\neach(s, () => {});\n`,
    });

    const { sites } = await analyze(view.checker, file, new PackageRoots());

    expect(sites.map(({ declarationFiles }) => [...declarationFiles].toSorted())).toStrictEqual([
      [
        "app/ecs.ts",
        "src/ecstatic/archetype.ts",
        "src/ecstatic/component.ts",
        "src/ecstatic/world.ts",
      ].map((rel) => projectPath(root, rel)),
    ]);
  });

  it.each([
    {
      name: "one storage",
      call: "each(register(createWorld(), Enemy), () => {});",
      expected: { filtered: false, arrayLiteral: false },
    },
    {
      name: "one storage with a filter",
      call: "each(register(createWorld(), Enemy), { all: [Position] }, () => {});",
      expected: { filtered: true, arrayLiteral: false },
    },
    {
      name: "an array literal of one storage",
      call: "each([register(createWorld(), Enemy)], () => {});",
      expected: { filtered: false, arrayLiteral: true },
    },
    {
      name: "an array literal with a filter",
      call: "each([register(createWorld(), Enemy)], { all: [Position] }, () => {});",
      expected: { filtered: true, arrayLiteral: true },
    },
  ])("records how an each call passes $name", async ({ call, expected }) => {
    const { sites } = await analyzeServed(RUNTIME_CASE, {
      [RUNTIME_CASE]: `${RUNTIME_PRELUDE}${call}\n`,
    });

    const [site] = sites;
    expect({
      op: site?.op,
      filtered: site?.filtered,
      arrayLiteral: site?.arrayLiteral,
    }).toStrictEqual({ op: "each", ...expected });
  });

  it.each<{ name: string; file: string; texts: Record<string, string> }>([
    {
      name: "a named import",
      ...installedCase(installedMain('import { each } from "ecstatic";', "each(s, () => {});")),
    },
    {
      name: "an import alias",
      ...installedCase(installedMain('import { each as e } from "ecstatic";', "e(s, () => {});")),
    },
    {
      name: "a namespace import",
      ...installedCase(installedMain('import * as ecs from "ecstatic";', "ecs.each(s, () => {});")),
    },
    {
      name: "a re-export through a user module",
      ...installedCase(
        installedMain('import { forEach } from "./reexport.js";', "forEach(s, () => {});"),
        { [INSTALLED_REEXPORT]: 'export { each as forEach } from "ecstatic";\n' },
      ),
    },
    {
      name: "a star re-export through a user module",
      ...installedCase(
        installedMain('import { each } from "./reexport.js";', "each(s, () => {});"),
        {
          [INSTALLED_REEXPORT]: 'export * from "ecstatic";\n',
        },
      ),
    },
    {
      name: "a namespace re-export through a user module",
      ...installedCase(
        installedMain('import { ecs } from "./reexport.js";', "ecs.each(s, () => {});"),
        { [INSTALLED_REEXPORT]: 'export * as ecs from "ecstatic";\n' },
      ),
    },
    {
      name: "a relative import of the repository sources",
      file: "repository/tests/each.test.ts",
      texts: {},
    },
  ])("recognizes an each call through $name", async ({ file, texts }) => {
    const { sites } = await analyzeServed(file, texts);

    expect(sites.map(({ op }) => op)).toStrictEqual(["each"]);
  });

  it.each<{ name: string; file: string; texts: Record<string, string> }>([
    {
      name: "an exported function with no op",
      ...installedCase('import { banana } from "ecstatic";\nbanana();\n'),
    },
    {
      name: "a same-named function from another package",
      ...installedCase(OTHER_EACH_SOURCE),
    },
    {
      name: "a same-named function from a package installed inside the repository",
      file: "repository/app/main.ts",
      texts: {},
    },
    {
      name: "a variable alias",
      ...installedCase(
        installedMain(
          'import { each } from "ecstatic";',
          "const myEach = each;\nmyEach(s, () => {});",
        ),
      ),
    },
  ])("ignores a call to $name", async ({ file, texts }) => {
    const { sites } = await analyzeServed(file, texts);

    expect(sites).toStrictEqual([]);
  });

  it.each([
    { name: "source directory", file: "repository/src/system.ts" },
    { name: "distribution directory", file: "repository/dist/system.ts" },
    { name: "subdirectory of the source directory", file: "repository/src/entity/system.ts" },
    {
      name: "subdirectory of the distribution directory",
      file: "repository/dist/entity/system.ts",
    },
  ])("skips a file in the runtime's $name", async ({ file }) => {
    const { sites } = await analyzeServed(file);

    expect(sites).toStrictEqual([]);
  });
});

describe("PackageRoots.root", () => {
  it.each([
    {
      name: "a package.json beside the file's directory",
      files: { "package.json": ECSTATIC_MANIFEST, "src/each.ts": "" },
      file: "src/each.ts",
      expected: ".",
    },
    {
      name: "the nearest of two ecstatic packages",
      files: {
        "package.json": ECSTATIC_MANIFEST,
        "inner/package.json": ECSTATIC_MANIFEST,
        "inner/dist/index.d.ts": "",
      },
      file: "inner/dist/index.d.ts",
      expected: "inner",
    },
    {
      name: "past directories that hold no package.json",
      files: { "package.json": ECSTATIC_MANIFEST, "sub/deeper/a.ts": "" },
      file: "sub/deeper/a.ts",
      expected: ".",
    },
    {
      name: "past a package with another name",
      files: {
        "package.json": ECSTATIC_MANIFEST,
        "sub/package.json": OTHER_MANIFEST,
        "sub/a.ts": "",
      },
      file: "sub/a.ts",
      expected: ".",
    },
    {
      name: "past a package.json that is not valid JSON",
      files: { "package.json": ECSTATIC_MANIFEST, "sub/package.json": "{", "sub/a.ts": "" },
      file: "sub/a.ts",
      expected: ".",
    },
    {
      name: "past a package.json whose name is not a string",
      files: {
        "package.json": ECSTATIC_MANIFEST,
        "sub/package.json": `{"name": 5}`,
        "sub/a.ts": "",
      },
      file: "sub/a.ts",
      expected: ".",
    },
    {
      name: "past an unreadable package.json",
      files: { "package.json": ECSTATIC_MANIFEST, "sub/package.json/keep": "", "sub/a.ts": "" },
      file: "sub/a.ts",
      expected: ".",
    },
  ])("finds $name", ({ files, file, expected }) => {
    const dir = writeProject(files);

    const found = new PackageRoots().root(projectPath(dir, file));

    expect(found).toBe(projectPath(dir, expected));
  });

  it("reports no root when no ancestor is an ecstatic package", () => {
    const dir = writeProject({ "package.json": OTHER_MANIFEST, "src/a.ts": "" });

    const found = new PackageRoots().root(projectPath(dir, "src/a.ts"));

    expect(found).toBeUndefined();
  });

  it("gives each file its nearest root after looking up some of their directories", () => {
    const dir = writeProject({
      "package.json": ECSTATIC_MANIFEST,
      "inner/package.json": ECSTATIC_MANIFEST,
      "inner/dist/index.d.ts": "",
      "inner/a.ts": "",
      "sub/package.json": OTHER_MANIFEST,
      "sub/a.ts": "",
      "sub/b.ts": "",
      "a.ts": "",
    });
    const roots = new PackageRoots();
    roots.root(projectPath(dir, "inner/dist/index.d.ts"));
    roots.root(projectPath(dir, "sub/a.ts"));
    const files = ["inner/dist/index.d.ts", "inner/a.ts", "sub/b.ts", "a.ts"];

    const found = Object.fromEntries(
      files.map((file) => [file, roots.root(projectPath(dir, file))]),
    );

    expect(found).toStrictEqual({
      "inner/dist/index.d.ts": projectPath(dir, "inner"),
      "inner/a.ts": projectPath(dir, "inner"),
      "sub/b.ts": projectPath(dir, "."),
      "a.ts": projectPath(dir, "."),
    });
  });
});
