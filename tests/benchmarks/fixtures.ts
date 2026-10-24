import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";

import { type Component, createWorld, type Storage, type World } from "ecstatic";

import {
  bgArch,
  chainArch,
  soa10Arch,
  soa1Arch,
  soa2Arch,
  soa5Arch,
  spawnArch,
  tagArch,
  trackedArch,
} from "../../benchmarks/archetypes.js";
import type { SoAColumns } from "../../src/ecstatic/world.js";
import { REPO_ROOT, writeFixture } from "../unit/plugin/tsconfig-fixtures.js";

/** The nine archetypes of a frame world. */
export const FRAME_ARCHETYPES = [
  trackedArch,
  bgArch,
  spawnArch,
  tagArch,
  chainArch,
  soa1Arch,
  soa2Arch,
  soa5Arch,
  soa10Arch,
] as const;

/** The context a bare-world benchmark builds: a world and nothing else. */
export interface BareWorldCtx {
  world: World;
}

/** A bare-world benchmark's context, holding a fresh empty world. */
export function buildBareWorld(): BareWorldCtx {
  return { world: createWorld() };
}

/** The column of `component`'s `field` in `storage`; throws when the storage has none. */
function fieldColumn(storage: Storage, component: Component, field: string): SoAColumns[string] {
  const column = storage.columns.get(component)?.[field];
  if (column === undefined) {
    throw new Error(`the storage has no column for field "${field}"`);
  }
  return column;
}

/**
 * `storage`'s live values of one field, read from its column.
 *
 * @param storage - Storage to read.
 * @param component - Component that declares the field.
 * @param field - Name of the field to read.
 * @returns The field's value in each live row, in row order.
 * @throws Error when `storage` has no column for `field` of `component`, so a misspelled name
 * fails instead of reading as an empty storage.
 */
export function liveValues(storage: Storage, component: Component, field: string): number[] {
  return Array.from(fieldColumn(storage, component, field), Number).slice(0, storage.n);
}

/**
 * Overwrites `storage`'s live values of one field, row by row.
 *
 * @param storage - Storage to write.
 * @param component - Component that declares the field.
 * @param field - Name of the field to write.
 * @param values - The value for each live row, in row order; must hold one per live row.
 * @throws Error when `storage` has no column for `field` of `component`, or `values` does not
 * hold exactly one value per live row.
 */
export function setLiveValues(
  storage: Storage,
  component: Component,
  field: string,
  values: readonly number[],
): void {
  const column = fieldColumn(storage, component, field);
  if (values.length !== storage.n) {
    throw new Error(`expected ${String(storage.n)} values, got ${String(values.length)}`);
  }
  values.forEach((value, row) => {
    column[row] = value;
  });
}

/** Narrows a value to a storage. */
export function isStorage(value: unknown): value is Storage {
  return typeof value === "object" && value !== null && "archetype" in value;
}

/** The tsconfig of the benchmark sources, which the runner's `--optimized` mode compiles. */
export const BENCHMARK_CONFIG = join(REPO_ROOT, "benchmarks", "tsconfig.json");

/** Opening a session and compiling every benchmark source, on a slow CI runner. */
export const COMPILE_TIMEOUT_MS = 180_000;

/**
 * Finds the helper_call benchmark's `= advance(` call.
 *
 * @param text - The iteration benchmarks' source or their compiled output.
 * @returns The index at which the call's `=` starts.
 * @throws Error when `text` holds no such call.
 */
export function advanceCall(text: string): number {
  const call = /=\s*advance\(/u.exec(text);
  if (call === null) throw new Error("the iteration benchmarks hold no advance call");
  return call.index;
}

/** A module whose `run()` calls `each()` over one mover with the `callback` expression. */
export function moverSource(callback: string): string {
  return `
import { archetype, component, createWorld, each, register, spawn } from "ecstatic";

const Position = component("Position", { x: 0, y: 0 });
const Mover = archetype([Position]);

export function run(): void {
  const movers = register(createWorld(), Mover);
  spawn(movers, { Position: { x: 1, y: 0 } });

  each(movers, ${callback});
}
`;
}

/** A source the strict compile refuses, and a diagnostic the failed compile reports. */
export interface CompileFailure {
  label: string;
  source: string;
  diagnostic: string;
}

/** One source per way an optimized compile fails: a TypeScript error, and a diagnostic only strict mode makes an error. */
export const COMPILE_FAILURES: readonly CompileFailure[] = [
  {
    label: "a TypeScript error",
    source: `${moverSource("(e) => { e.Position.x += 1; }")}\nexport const label: string = 5;\n`,
    diagnostic: "TS2322",
  },
  {
    label: "a strict optimizer diagnostic",
    source: moverSource(`function* (e) {
    e.Position.x += 1;
  }`),
    diagnostic: "the callback is a generator function",
  },
];

/** What the runner's entry reads beside `benchmarks/`: its imports, the runtime sources the benchmark tsconfig maps, and the tsconfig it extends. */
const ENTRY_TREE = ["benchmarks", "scripts", "src", "package.json", "tsconfig.json"];

const benchmarkProjects: string[] = [];

/**
 * Creates an empty directory in the repository's `node_modules/.cache`, from which the benchmark
 * tsconfig's `types` and `paths` resolve as they do from `benchmarks/`.
 *
 * @returns The directory; `removeBenchmarkProjects` deletes it.
 * @throws Error when the directory cannot be created.
 */
function benchmarkProjectDir(): string {
  const cache = join(REPO_ROOT, "node_modules", ".cache");
  mkdirSync(cache, { recursive: true });
  const dir = mkdtempSync(join(cache, "ecstatic-bench-"));
  benchmarkProjects.push(dir);
  return dir;
}

/**
 * Creates a project holding `source` as `main.ts`, compiled with `BENCHMARK_CONFIG` itself.
 *
 * @param source - Contents of the project's only source file.
 * @returns The path of the project's tsconfig; `removeBenchmarkProjects` deletes the project.
 * @throws Error when the project's files cannot be written.
 */
export function benchmarkConfigProject(source: string): string {
  const dir = benchmarkProjectDir();
  writeFixture(join(dir, "tsconfig.json"), { extends: BENCHMARK_CONFIG, include: ["main.ts"] });
  writeFixture(join(dir, "main.ts"), source);
  return join(dir, "tsconfig.json");
}

/**
 * Copies the benchmark sources and what the runner's entry reads beside them, adding `source` as one
 * more benchmark source, so a run of the copied entry compiles it with the rest.
 *
 * The copy links the repository's `dist/`, which its `import "ecstatic"` resolves to as the
 * repository's own entry does.
 *
 * @param source - Contents of the added source, `benchmarks/added.ts` in the copy.
 * @returns The copy's `benchmarks/main.ts`; `removeBenchmarkProjects` deletes the copy.
 * @throws Error when the copy cannot be written.
 */
export function benchmarkTreeWith(source: string): string {
  const dir = benchmarkProjectDir();
  for (const entry of ENTRY_TREE) {
    cpSync(join(REPO_ROOT, entry), join(dir, entry), { recursive: true });
  }
  symlinkSync(join(REPO_ROOT, "dist"), join(dir, "dist"), "junction");
  writeFixture(join(dir, "benchmarks", "added.ts"), source);
  return join(dir, "benchmarks", "main.ts");
}

/** Removes every project `benchmarkConfigProject` and `benchmarkTreeWith` made. */
export function removeBenchmarkProjects(): void {
  for (const dir of benchmarkProjects.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
}
