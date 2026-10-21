/**
 * The two spellings of a file name the optimizer meets. The compiler separates every file name with
 * `/`, Windows included, while Node's `path` functions and the optimizer's callers use the
 * platform's separator. `compiler.ts` respells every name it hands the compiler or returns from it,
 * so the rest of the optimizer sees the platform's spelling alone.
 */

import { sep } from "node:path";

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
