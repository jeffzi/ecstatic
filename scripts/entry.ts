import { existsSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Compare the script Node was started with against a module by real path, so a script path that
 * goes through a symlinked directory still counts.
 *
 * @param moduleUrl - The calling module's `import.meta.url`.
 * @returns Whether that module is the script Node was started with.
 */
export function isEntryScript(moduleUrl: string): boolean {
  const entry = process.argv[1];
  if (entry === undefined) {
    return false;
  }
  const entryPath = resolve(entry);
  return (
    existsSync(entryPath) && realpathSync(entryPath) === realpathSync(fileURLToPath(moduleUrl))
  );
}
