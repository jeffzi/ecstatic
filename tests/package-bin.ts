import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);

/**
 * The script a manifest's `bin` maps to `command`, or undefined when there is none; a string-form
 * `bin` maps only the package's own name.
 */
function binEntry(bin: unknown, packageName: string, command: string): unknown {
  if (typeof bin === "string") return command === packageName ? bin : undefined;
  if (typeof bin !== "object" || bin === null) return undefined;
  return new Map(Object.entries(bin)).get(command);
}

/**
 * The script behind the `command` bin of `packageName`, to spawn as `process.execPath` followed by
 * the script and its arguments.
 *
 * `node_modules/.bin` holds shell and `.cmd` shims, which Windows cannot spawn without a shell. The
 * script they wrap runs under Node on every platform.
 *
 * @param packageName - The installed package that declares the bin.
 * @param command - The bin's name; a package whose `bin` is a single path names it after itself.
 * @returns The absolute path of the bin's script.
 * @throws Error when `packageName` cannot be resolved or declares no bin named `command`.
 * @throws SyntaxError when the package's manifest is not valid JSON.
 * @throws Error when the package's manifest cannot be read; the `readFileSync` system error passes
 *   through.
 */
export function packageBin(packageName: string, command: string): string {
  const manifest = require.resolve(`${packageName}/package.json`);
  const { bin }: { bin?: unknown } = JSON.parse(readFileSync(manifest, "utf8"));
  const script = binEntry(bin, packageName, command);
  if (typeof script !== "string") {
    throw new Error(`${packageName} declares no bin named ${command}`);
  }
  return join(dirname(manifest), script);
}
