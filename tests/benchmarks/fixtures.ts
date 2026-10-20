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
