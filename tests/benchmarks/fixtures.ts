import { mkdirSync } from "node:fs";
import { join } from "node:path";

import type { Component, Storage } from "ecstatic";

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
import type { TimedYield } from "../../benchmarks/helpers.js";
import { createTempDir, REPO_ROOT, writeFixtures } from "../unit/plugin/tsconfig-fixtures.js";

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
  const column = storage.columns.get(component)?.[field];
  if (column === undefined) {
    throw new Error(`the storage has no column for field "${field}"`);
  }
  return Array.from(column, Number).slice(0, storage.n);
}

/** Narrows a generator's yielded value to the `timedBench` shape. */
function isTimedYield(value: unknown): value is TimedYield {
  return (
    typeof value === "object" &&
    value !== null &&
    "heap" in value &&
    value.heap === false &&
    "bench" in value &&
    typeof value.bench === "function"
  );
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
  const column = storage.columns.get(component)?.[field];
  if (column === undefined) {
    throw new Error(`the storage has no column for field "${field}"`);
  }
  if (values.length !== storage.n) {
    throw new Error(`expected ${String(storage.n)} values, got ${String(values.length)}`);
  }
  values.forEach((value, row) => {
    column[row] = value;
  });
}

/** Takes a generator's first yield and returns its `timedBench` body, throwing when it is not one. */
export function firstTimedBody(gen: Generator<unknown, unknown, unknown>): () => void {
  const first: unknown = gen.next().value;
  if (!isTimedYield(first)) {
    throw new Error("the first yield is not a timedBench yield");
  }
  return first.bench;
}

/** Narrows a value to a storage. */
export function isStorage(value: unknown): value is Storage {
  return typeof value === "object" && value !== null && "archetype" in value;
}

/** The tsconfig the benchmark runner's `--optimized` mode compiles the benchmark sources with. */
export const OPTIMIZER_CONFIG = join(REPO_ROOT, "benchmarks", "tsconfig.optimizer.json");

/** The first compile builds the Go optimizer through ttsc, about a minute on a cold cache. */
export const COMPILE_TIMEOUT_MS = 240_000;

/** A module whose `run()` calls `each()` over one mover with the `callback` expression. */
function moverSource(callback: string): string {
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

/** A source the optimizer config refuses to compile, and a diagnostic the failed compile prints. */
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
    source: moverSource(`async (e) => {
    e.Position.x += 1;
    await Promise.resolve();
  }`),
    diagnostic: "the callback is async",
  },
];

/**
 * Creates a project holding `source` as `main.ts`, compiled with `OPTIMIZER_CONFIG` itself.
 *
 * The project lives in the repository's `node_modules/.cache`: the config sets `rootDir` to the
 * repository, so a source outside it fails the compile on that alone, and from there ttsc finds
 * typescript and keeps its built-plugin cache in the repository's `node_modules`.
 *
 * @param source - Contents of the project's only source file.
 * @returns The path of the project's tsconfig; `removeTempDirs` deletes the project.
 * @throws Error when the project's files cannot be written.
 */
export function optimizerConfigProject(source: string): string {
  const cache = join(REPO_ROOT, "node_modules", ".cache");
  mkdirSync(cache, { recursive: true });
  const dir = createTempDir(cache);
  writeFixtures(dir, {
    "tsconfig.json": { extends: OPTIMIZER_CONFIG, include: ["main.ts"] },
    "main.ts": source,
  });
  return join(dir, "tsconfig.json");
}
