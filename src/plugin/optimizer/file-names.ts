/**
 * The two spellings of a file name the optimizer meets. The compiler separates every file name with
 * `/`, Windows included, while Node's `path` functions and the optimizer's callers use the
 * platform's separator. `compiler.ts` respells every name it hands the compiler or returns from it,
 * so the rest of the optimizer sees the platform's spelling alone.
 */

import { sep } from "node:path";

/** Matches only a lower-case drive letter, so `fileKey` leaves an upper-case one as written. */
const DRIVE_LETTER = /^[a-z](?=:)/u;

/**
 * The platform's spelling of a file name the compiler wrote.
 *
 * @param name - A file name as the compiler wrote it.
 * @param separator - The platform's path separator; `path.sep` when absent.
 * @returns The name with `separator` between its segments.
 */
export function nativeFileName(name: string, separator: string = sep): string {
  return separator === "/" ? name : name.replaceAll("/", separator);
}

/**
 * The compiler's spelling of a file name, so every name the compiler is handed is spelled as it
 * writes names itself. A POSIX name keeps any `\` it holds, as part of a segment.
 *
 * @param name - A file name in the platform's spelling.
 * @param separator - The platform's path separator; `path.sep` when absent.
 * @returns The name with `/` between its segments.
 */
export function compilerFileName(name: string, separator: string = sep): string {
  return separator === "/" ? name : name.replaceAll(separator, "/");
}

/**
 * The key that matches a file however its path is written. Vite writes module ids with `/`
 * separators while the compiler and Node write native paths, and on Windows either side may spell
 * the drive letter in either case. The rest of the path keeps its case, and a POSIX name keeps any
 * `\` it holds as part of a segment, so two distinct files never share a key.
 *
 * @param path - An absolute file path: a Vite id or a name in the platform's spelling.
 * @param separator - The platform's path separator; `path.sep` when absent.
 * @returns The path unchanged when `separator` is `/`; otherwise the path with `/` separators and
 *   an upper-case drive letter.
 */
export function fileKey(path: string, separator: string = sep): string {
  if (separator === "/") return path;
  return compilerFileName(path, separator).replace(DRIVE_LETTER, (letter) => letter.toUpperCase());
}
