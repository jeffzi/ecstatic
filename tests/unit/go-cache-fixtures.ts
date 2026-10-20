import { existsSync, mkdirSync, truncateSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const HOUR = 60 * 60_000;
export const GIB = 2 ** 30;

/** The number of hex digits in the hash of a Go build cache entry's file name. */
export const HASH_DIGITS = 64;

/** The path of entry number `seed` of `kind` in bucket `bucket` of `cache`. */
export function entryPath(cache: string, bucket: string, seed: number, kind: "a" | "d"): string {
  const hash = seed.toString(16).padStart(HASH_DIGITS - bucket.length, "0");
  return join(cache, bucket, `${bucket}${hash}-${kind}`);
}

/** Writes a sparse `size`-byte file at `path`, creating parent directories, with an mtime `age` before `now`. */
export function writeSized(
  path: string,
  size: number,
  age: number,
  now: number = Date.now(),
): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, "");
  truncateSync(path, size);
  const time = new Date(now - age);
  utimesSync(path, time, time);
  return path;
}

/** Writes a sparse `-a` entry of `size` bytes in `bucket` of `cache`, last used `age` before now, and returns its path. */
export function writeEntry(cache: string, bucket: string, size: number, age: number): string {
  return writeSized(entryPath(cache, bucket, 1, "a"), size, age);
}

/** Whether each of `paths` still exists. */
export function survivors(paths: readonly string[]): boolean[] {
  return paths.map((path) => existsSync(path));
}
