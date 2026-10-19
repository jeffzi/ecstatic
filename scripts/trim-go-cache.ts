import { readdirSync, rmSync, statSync, type Stats } from "node:fs";
import { join } from "node:path";

const GIB = 2 ** 30;

/** Go's cache spreads entries over 256 subdirectories named by the first byte of their key. */
const BUCKET_NAME = /^[0-9a-f]{2}$/;
/** An action (`-a`) or output (`-d`) entry; Go's own trim selects entries by the same names. */
const ENTRY_NAME = /^[0-9a-f]{64}-[ad]$/;

const SIZE_UNITS = [
  ["TiB", 2 ** 40],
  ["GiB", GIB],
  ["MiB", 2 ** 20],
  ["KiB", 2 ** 10],
] as const;

/** Limits and clock for one trim. */
export interface TrimOptions {
  /** The current time, in milliseconds since the epoch. */
  readonly now: number;
  /** The total entry size, in bytes, above which the trim deletes entries. */
  readonly cap: number;
  /** The total entry size, in bytes, the trim deletes down to once past the cap. */
  readonly target: number;
  /** How long, in milliseconds, an entry counts as recent after its mtime. */
  readonly protectedAge: number;
  /** Called with each deletion candidate's path after the scan and before its mtime is re-read. */
  readonly beforeDelete?: (path: string) => void;
}

/** A cache entry as the scan found it. */
interface Entry {
  readonly path: string;
  readonly size: number;
  readonly mtimeMs: number;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isGone(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

/**
 * Run a filesystem call on a path that may vanish while the trim runs.
 *
 * @param verb - The action named in the error message.
 * @param path - The path the call acts on.
 * @param call - The filesystem call.
 * @returns What `call` returns, or `undefined` when `path` is gone.
 * @throws Error naming `verb` and `path` when `call` fails for any other reason.
 */
function unlessGone<T>(verb: "read" | "delete", path: string, call: () => T): T | undefined {
  try {
    return call();
  } catch (error) {
    if (isGone(error)) return undefined;
    throw new Error(`cannot ${verb} ${path}: ${errorMessage(error)}`, { cause: error });
  }
}

/**
 * List a directory that may vanish while the trim runs.
 *
 * @param path - The directory to list.
 * @returns The names in `path`, or `undefined` when it is gone.
 * @throws Error naming `path` when listing fails for any other reason.
 */
function listDir(path: string): string[] | undefined {
  return unlessGone("read", path, () => readdirSync(path));
}

/**
 * Stat a path that may vanish while the trim runs, following symbolic links.
 *
 * @param path - The path to stat.
 * @returns The stats of `path`, or `undefined` when it is gone.
 * @throws Error naming `path` when reading it fails for any other reason.
 */
function statPath(path: string): Stats | undefined {
  return unlessGone("read", path, () => statSync(path));
}

function outputDirSize(path: string): number {
  let size = 0;
  for (const name of listDir(path) ?? []) {
    const stats = statPath(join(path, name));
    if (stats?.isFile() === true) size += stats.size;
  }
  return size;
}

function scanBucket(bucket: string, entries: Entry[]): void {
  for (const name of listDir(bucket) ?? []) {
    if (!ENTRY_NAME.test(name)) continue;
    const path = join(bucket, name);
    const stats = statPath(path);
    if (stats === undefined) continue;
    const size = stats.isDirectory() ? outputDirSize(path) : stats.size;
    entries.push({ path, size, mtimeMs: stats.mtimeMs });
  }
}

function scanCache(dir: string): Entry[] {
  const entries: Entry[] = [];
  for (const name of listDir(dir) ?? []) {
    if (!BUCKET_NAME.test(name)) continue;
    const bucket = join(dir, name);
    if (statPath(bucket)?.isDirectory() === true) scanBucket(bucket, entries);
  }
  return entries;
}

/**
 * Delete an entry, removing a `-d` directory whole.
 *
 * @param path - The entry to delete.
 * @returns `true` when this call deleted it, `false` when it was already gone.
 * @throws Error naming `path` when deleting fails for any other reason.
 */
function deleteEntry(path: string): boolean {
  const deleted = unlessGone("delete", path, () => {
    rmSync(path, { recursive: true });
    return true;
  });
  return deleted ?? false;
}

function formatSize(bytes: number): string {
  for (const [unit, size] of SIZE_UNITS) {
    if (bytes >= size) return `${(bytes / size).toFixed(1)} ${unit}`;
  }
  return `${bytes} B`;
}

function isRecent(mtimeMs: number, options: TrimOptions): boolean {
  return options.now - mtimeMs < options.protectedAge;
}

/**
 * Find where the spared share of the entries starts: the recent entries, taken newest first, up to
 * the first one that would push their total past the target.
 *
 * @param entries - The scanned entries, oldest mtime first.
 * @param options - The target, the protection window, and the clock.
 * @returns The index of the first spared entry; every entry from it on is spared, and
 * `entries.length` means none is.
 */
function protectedStart(entries: readonly Entry[], options: TrimOptions): number {
  let spared = 0;
  let size = 0;
  for (const entry of entries.toReversed()) {
    if (!isRecent(entry.mtimeMs, options) || size + entry.size > options.target) break;
    size += entry.size;
    spared += 1;
  }
  return entries.length - spared;
}

/**
 * Delete entries in order until the total reaches the target.
 *
 * @param entries - The deletion candidates, oldest mtime first.
 * @param before - The total size of every scanned entry, in bytes.
 * @param options - The target and the pre-deletion hook.
 * @returns The total left and the number of entries this call deleted; an entry already gone at its
 * deletion counts toward the total freed but not toward the number deleted.
 * @throws Error naming the path when re-reading or deleting an entry fails for any reason other
 * than the entry being gone.
 * @throws Whatever `options.beforeDelete` throws.
 */
function deleteOldest(
  entries: readonly Entry[],
  before: number,
  options: TrimOptions,
): { readonly total: number; readonly removed: number } {
  let total = before;
  let removed = 0;
  for (const entry of entries) {
    if (total <= options.target) break;
    options.beforeDelete?.(entry.path);
    // A build may have refreshed the mtime since the scan read it.
    const current = statPath(entry.path);
    if (current !== undefined) {
      if (current.mtimeMs > entry.mtimeMs) continue;
      if (deleteEntry(entry.path)) removed += 1;
    }
    total -= entry.size;
  }
  return { total, removed };
}

/**
 * Keep a Go build cache under a size cap by deleting its least recently used entries.
 *
 * Only entries count and only entries are deleted: files or directories named `<64 hex>-a` or
 * `<64 hex>-d` directly inside a two-hex-digit subdirectory of `dir`. A `-d` directory counts as the
 * total size of the files inside it and is removed whole. Everything else, `trim.txt` included, is
 * left untouched, so Go's own trim schedule is unchanged.
 *
 * When the entries total more than `options.cap`, entries are deleted oldest mtime first until the
 * total is at or below `options.target`. An entry is recent when its mtime is less than
 * `options.protectedAge` before `options.now`. Recent entries are spared newest mtime first while
 * the spared ones total no more than `options.target`; the first recent entry that would push that
 * total past the target, and every older recent entry, is a deletion candidate like any other
 * entry, so the window protects at most one target's worth of the cache. A candidate whose mtime,
 * re-read just before its deletion, is newer than the scan saw is spared too: a build used it in
 * the meantime. Anything that vanishes while the trim runs (another trim, Go's own trim,
 * `go clean -cache`) is not an error: it is left out of the total when the scan misses it, and
 * counts as freed when it is gone at its deletion.
 *
 * When anything is deleted, one line with the size before, the size after, and the number of
 * entries removed is written to stderr.
 *
 * @param dir - The cache root; a missing directory deletes nothing.
 * @param options - The current time, the cap, the target, the protection window, and an optional
 * hook run before each candidate's mtime is re-read.
 * @throws Error naming the path when reading or deleting part of the cache fails for any reason
 * other than the path being gone.
 * @throws Whatever `options.beforeDelete` throws.
 */
export function trimGoCache(dir: string, options: TrimOptions): void {
  const entries = scanCache(dir);
  const before = entries.reduce((sum, entry) => sum + entry.size, 0);
  if (before <= options.cap) return;

  entries.sort((a, b) => a.mtimeMs - b.mtimeMs);
  const candidates = entries.slice(0, protectedStart(entries, options));
  const { total, removed } = deleteOldest(candidates, before, options);
  if (removed > 0) {
    const noun = removed === 1 ? "entry" : "entries";
    process.stderr.write(
      `Trimmed the Go build cache from ${formatSize(before)} to ${formatSize(total)} by removing ${removed} ${noun}\n`,
    );
  }
}
