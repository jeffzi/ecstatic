/** A Windows drive letter at the start of a path. */
const DRIVE_LETTER = /^[a-z](?=:)/u;

/**
 * The key that matches a file however its path is written. Vite writes module ids with `/`
 * separators, while the compiler and Node write native paths, and either side may spell a Windows
 * drive letter in either case. The rest of the path keeps its case: only the drive letter is
 * case-insensitive on every platform.
 *
 * @param path - An absolute file path, with either separator.
 * @returns The path with `/` separators and an upper-case drive letter.
 */
export function fileKey(path: string): string {
  return path.replaceAll("\\", "/").replace(DRIVE_LETTER, (letter) => letter.toUpperCase());
}
