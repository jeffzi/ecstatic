import { execFile } from "node:child_process";
import { writeFileSync } from "node:fs";
import { promisify } from "node:util";

import type { SourceFile } from "typescript/ast";

import { analyze } from "../../../../src/plugin/optimizer/analysis/analyze.js";
import { PackageRoots } from "../../../../src/plugin/optimizer/analysis/roots.js";
import type { Rule } from "../../../../src/plugin/optimizer/emit/catalog.js";
import { createEmitFile, type EmitFile } from "../../../../src/plugin/optimizer/emit/emit.js";
import type { NodeID, Site, ViewUse } from "../../../../src/plugin/optimizer/facts.js";
import type { NodeTable } from "../../../../src/plugin/optimizer/nodes.js";
import { type EachInlining, type Mode, plan } from "../../../../src/plugin/optimizer/plan.js";
import type { Session } from "../../../../src/plugin/optimizer/session.js";
import { packageBin } from "../../../package-bin.js";
import { openProject, projectPath, RUNTIME_TSCONFIG, runtimeProject } from "../project.js";

const execFileAsync = promisify(execFile);

/**
 * Makes the project an ecstatic package root whose entry points are its own runtime sources, so
 * emitted code importing `ecstatic/internal` runs against them.
 */
const PACKAGE_JSON = JSON.stringify({
  name: "ecstatic",
  type: "module",
  exports: { ".": "./src/ecstatic/index.ts", "./internal": "./src/ecstatic/internal.ts" },
});

/**
 * The runtime compiler options over the runtime and `app/*.ts` alone, so the emitted `.mts` files
 * written beside the cases stay out of the program.
 */
const TSCONFIG = ((): string => {
  const runtime: Record<string, unknown> = JSON.parse(RUNTIME_TSCONFIG);
  return JSON.stringify({ ...runtime, include: ["src/**/*.ts", "app/*.ts"] });
})();

const SCHEMA_SOURCE = `import { archetype, component, createWorld, ref, register, relation, spawn, u8 } from "../src/ecstatic/index.js";

export const Position = component("Position", { x: 0, y: 0 });
export const Velocity = component("Velocity", { dx: 0, dy: 0 });
export const Label = component("Label", { text: "" });
export const Pair = component("A,B", { n: 0 });
export const Flags = component("Flags", { on: false });
export const Shield = component("Shield", { hp: 0, up: false, level: u8(0) });
export const Stunned = component("Stunned");
export const Boost = component("Boost");
export const Tether = relation("Tether", { slack: 0 });
export const Leash = relation("Leash", { length: 0 });
export const Mark = component("Mark", { first: ref<number>(), second: ref<number>() });
export const Scale = component("Scale", { x: 1, y: 1 });

export const Mover = archetype([Position, Velocity]);
export const Statue = archetype([Position, Label]);
export const Paired = archetype([Pair, Position]);
export const Guarded = archetype([Position, Flags, Stunned], [Shield, Boost]);
export const Tethered = archetype([Position, Tether], [Leash]);
export const Marked = archetype([Position], [Mark]);
export const Pinned = archetype([Mark]);
export const Sized = archetype([Position, Scale]);

// guarded registers a Guarded storage holding a row with every optional enabled, then a row with none.
export function guarded() {
    const storage = register(createWorld(), Guarded);
    const ids = [
        spawn(storage, { Position: { x: 1, y: 0 }, Flags: { on: true }, Shield: { hp: 5, up: true, level: 2 }, Boost: true }),
        spawn(storage, { Position: { x: 2, y: 0 } }),
    ];
    return { storage, ids };
}

// marked registers a Marked storage holding a row whose Mark is enabled with both fields unset, then a row without it.
export function marked() {
    const storage = register(createWorld(), Marked);
    const ids = [spawn(storage, { Position: { x: 1, y: 0 }, Mark: {} }), spawn(storage, { Position: { x: 2, y: 0 } })];
    return { storage, ids };
}
`;

/** Opens every case file but the preamble's: the runtime API and the schema. */
export const CASE_PRELUDE = `import { createWorld, disable, each, enable, get, has, register, spawn, spawnMany, type Storage } from "../src/ecstatic/index.js";
import { Flags, Label, Leash, Mark, Mover, Pair, Paired, Pinned, Position, Scale, Shield, Sized, Statue, Tether, Tethered, Velocity, guarded, marked } from "./schema.js";
`;

/** Opens a scenario with a Mover storage of three rows whose Position.x is 1, 2, then 3. */
export const THREE_MOVERS = `export function scenario(): unknown {
    const movers = register(createWorld(), Mover);
    spawn(movers, { Position: { x: 1, y: 0 }, Velocity: { dx: 0, dy: 0 } });
    spawn(movers, { Position: { x: 2, y: 0 }, Velocity: { dx: 0, dy: 0 } });
    spawn(movers, { Position: { x: 3, y: 0 }, Velocity: { dx: 0, dy: 0 } });
`;

/**
 * A hazard-free body over a Guarded storage that reads two columns, the entity array, and the
 * presence mask, and writes a column.
 */
export const MODE_SOURCE = `const { storage } = guarded();
each(storage, (e) => {
    e.Position.x = e.Position.y + e.id;
    if (e.Shield) {
        e.Position.y = 1;
    }
});
`;

/** Every mode an inlined loop can run in. */
export const MODES: readonly Mode[] = ["hoisted", "realloc-safe"];

/** A scenario run on the runtime and through its rewrite, and the result every run gives. */
export interface RunCase {
  readonly name: string;
  /** The case file's text after {@link CASE_PRELUDE}, exporting a `scenario` function. */
  readonly source: string;
  readonly expected: unknown;
}

/**
 * The result {@link EmitProject.runEveryMode} gives when the runtime and every mode in `modes`
 * return `expected`.
 *
 * @param expected - The result every run returns.
 * @param modes - The modes the scenario ran in.
 * @returns `expected` keyed by `runtime` and by each mode.
 */
export function everyMode(expected: unknown, modes: readonly Mode[] = MODES): unknown {
  return Object.fromEntries(["runtime", ...modes].map((run) => [run, expected]));
}

/**
 * The result {@link EmitProject.runEverySetting} gives when every run of a scenario in `modes`
 * returns `expected`.
 *
 * @param expected - The result every run returns.
 * @param modes - The modes the scenario ran in.
 * @returns `expected` keyed by run, for the checked and the stripped setting.
 */
export function everyRun(expected: unknown, modes: readonly Mode[] = MODES): unknown {
  const byRun = everyMode(expected, modes);
  return { checked: byRun, stripped: byRun };
}

/** How long a case that runs emitted code in a child process may take on a slow CI runner. */
export const RUN_TIMEOUT_MS = 30_000;

/** How many case files a project holds; each case takes the next one. */
const CASE_SLOTS = 128;

/** The slash-separated path of the `i`th case file. */
function caseFile(i: number): string {
  return `app/case${i}.ts`;
}

/** The slash-separated path of the case file at `rel`, without its `app/` directory and `.ts`. */
function caseStem(rel: string): string {
  return rel.slice("app/".length, -".ts".length);
}

/**
 * The `index`th inlining of `planned`.
 *
 * @param planned - The planned case.
 * @param index - Position in the plan's rewrites.
 * @returns The inlining at that position.
 * @throws Error when the plan has fewer rewrites.
 */
export function rewriteAt(planned: PlannedCase, index: number): EachInlining {
  const inlining = planned.rewrites[index];
  if (inlining === undefined) throw new Error(`${planned.rel} plans no inlining ${index}`);
  return inlining;
}

/** A case file served through the session, analyzed and planned. */
export interface PlannedCase {
  /** The case file's slash-separated path in the project. */
  readonly rel: string;
  readonly source: SourceFile;
  readonly table: NodeTable;
  /** The plan's inlined sites, in plan order. */
  readonly rewrites: readonly EachInlining[];
  /** The view uses of each inlined call's callback. */
  readonly uses: ReadonlyMap<NodeID, readonly ViewUse[]>;
}

/** What one emit of a planned case gives. */
export interface Rewritten {
  readonly text: string;
  readonly applied: readonly Rule[];
}

/** How a test emits a planned case. */
export interface EmitOptions {
  /** Replaces the plan's mode on every inlining. */
  readonly mode?: Mode;
  /** The runtime root whose `DEBUG` the preamble copies; the project's own by default. */
  readonly root?: string;
  /** Emits each inlining into the file in place of a plain `inline` call. */
  readonly inline?: (file: EmitFile, inlining: EachInlining, uses: readonly ViewUse[]) => void;
  /** Passed to {@link createEmitFile}. */
  readonly beforeCommit?: (inlining: EachInlining) => void;
}

/** Maps the call of every site in `sites`, at any depth, to the view uses of its callback. */
function viewUses(sites: readonly Site[], uses = new Map<NodeID, readonly ViewUse[]>()) {
  for (const site of sites) {
    if (site.callback !== undefined) uses.set(site.call, site.callback.viewUses);
    viewUses(site.nested, uses);
  }
  return uses;
}

/** A project holding the runtime, the schema, and the case files, with one session over it. */
export class EmitProject {
  readonly root: string;
  readonly session: Session;
  #next = 0;
  #runs = 0;

  private constructor(root: string, session: Session) {
    this.root = root;
    this.session = session;
  }

  /** Writes the project and opens its session. */
  static async open(): Promise<EmitProject> {
    const placeholders = Object.fromEntries(
      Array.from({ length: CASE_SLOTS }, (_, i) => [caseFile(i), "export {};\n"]),
    );
    const { root, session } = await openProject(
      runtimeProject({
        "tsconfig.json": TSCONFIG,
        "package.json": PACKAGE_JSON,
        "app/schema.ts": SCHEMA_SOURCE,
        ...placeholders,
      }),
    );
    return new EmitProject(root, session);
  }

  /**
   * Serves `text` as the next case file, writes it to disk so it runs, then analyzes and plans it.
   *
   * @param text - The case file's text.
   * @returns The case, analyzed and planned.
   * @throws Error when the plan rewrites no site.
   */
  async planned(text: string): Promise<PlannedCase> {
    const rel = caseFile(this.#next++);
    const path = projectPath(this.root, rel);
    writeFileSync(path, text);
    const view = await this.session.update({ [path]: text });
    const source = await view.sourceFile(path);
    const { sites, table } = await analyze(view.checker, source, new PackageRoots());
    const { bails, rewrites } = plan(sites);
    if (rewrites.length === 0) {
      throw new Error(`${rel}: the plan rewrites no site; bails ${JSON.stringify(bails)}`);
    }
    return { rel, source, table, rewrites, uses: viewUses(sites) };
  }

  /** Emits every inlining of `planned`, in plan order, and prints the file. */
  async emit(planned: PlannedCase, options: EmitOptions = {}): Promise<Rewritten> {
    const beforeCommit =
      options.beforeCommit === undefined ? {} : { beforeCommit: options.beforeCommit };
    const file = await createEmitFile(this.session, planned.source, planned.table, {
      root: options.root ?? this.root,
      ...beforeCommit,
    });
    for (const rewrite of planned.rewrites) {
      const inlining = options.mode === undefined ? rewrite : { ...rewrite, mode: options.mode };
      const uses = planned.uses.get(rewrite.call) ?? [];
      if (options.inline === undefined) file.inline(inlining, uses);
      else options.inline(file, inlining, uses);
    }
    const { text } = await file.print();
    return { text, applied: file.applied() };
  }

  /** Plans `text` as a case file and emits it. */
  async rewrite(text: string, options: EmitOptions = {}): Promise<Rewritten> {
    return this.emit(await this.planned(text), options);
  }

  /**
   * Emits `planned` and writes the text beside its case file under the name `label`.
   *
   * @param planned - The case to emit.
   * @param label - The name the written file takes after the case file's.
   * @param options - How the case is emitted.
   * @returns The written file's path relative to the case file's directory.
   */
  async emitModule(
    planned: PlannedCase,
    label: string,
    options: EmitOptions = {},
  ): Promise<string> {
    const { text } = await this.emit(planned, options);
    const name = `${caseStem(planned.rel)}.${label}.mts`;
    writeFileSync(projectPath(this.root, `app/${name}`), text);
    return `./${name}`;
  }

  /**
   * Runs the scenario of `source`, opened by {@link CASE_PRELUDE}, on the runtime and through its
   * rewrite in each mode.
   *
   * @param source - The case file's text after the prelude, exporting a `scenario` function.
   * @returns The scenario's result keyed by `runtime` and by mode.
   */
  async runEveryMode(source: string): Promise<unknown> {
    return this.run(await this.#emitModes(source, MODES));
  }

  /**
   * Runs the scenario of `source`, opened by {@link CASE_PRELUDE}, on the runtime and through its
   * rewrite in each of `modes`, once with the checks on and once under `NDEBUG`.
   *
   * @param source - The case file's text after the prelude, exporting a `scenario` function.
   * @param modes - The modes the rewrite runs in.
   * @returns The scenario's result keyed by `runtime` and by mode, for each setting.
   */
  async runEverySetting(
    source: string,
    modes: readonly Mode[] = MODES,
  ): Promise<{ checked: unknown; stripped: unknown }> {
    const modules = await this.#emitModes(source, modes);
    const [checked, stripped] = await Promise.all([this.run(modules), this.run(modules, true)]);
    return { checked, stripped };
  }

  /**
   * Plans `source`, opened by {@link CASE_PRELUDE}, and writes its rewrite in each of `modes`.
   *
   * @returns The module paths, relative to `app/`, of the case file under `runtime` and of each
   *   rewrite under its mode.
   */
  async #emitModes(source: string, modes: readonly Mode[]): Promise<Record<string, string>> {
    const planned = await this.planned(CASE_PRELUDE + source);
    const modules: Record<string, string> = { runtime: `./${caseStem(planned.rel)}.js` };
    for (const mode of modes) {
      modules[mode] = await this.emitModule(planned, mode, { mode });
    }
    return modules;
  }

  /**
   * Imports each module of `modules` in one process, with `globalThis.NDEBUG` set when `ndebug`,
   * and calls its `scenario` export.
   *
   * @param modules - Module paths relative to `app/`, keyed by the name their result takes.
   * @param ndebug - Whether the process sets `globalThis.NDEBUG` before any import.
   * @returns What each module's `scenario` returned, as JSON decodes it, keyed as `modules` is.
   */
  async run(modules: Readonly<Record<string, string>>, ndebug = false): Promise<unknown> {
    const runner = projectPath(this.root, `app/run${this.#runs++}.mjs`);
    writeFileSync(
      runner,
      `${ndebug ? "globalThis.NDEBUG = true;\n" : ""}const modules = ${JSON.stringify(modules)};
const results = {};
for (const [name, path] of Object.entries(modules)) {
  results[name] = (await import(path)).scenario();
}
console.log(JSON.stringify(results));
`,
    );
    const { stdout } = await execFileAsync(process.execPath, [packageBin("tsx", "tsx"), runner], {
      cwd: this.root,
    });
    const results: unknown = JSON.parse(stdout);
    return results;
  }
}
