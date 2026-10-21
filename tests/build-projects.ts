import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");

/** Narrows a parsed JSON value to a plain object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The tsconfig each command of a `build` script compiles, in script order.
 *
 * @param script - The script, its commands separated by `&&`.
 * @returns Each project's path as the script names it.
 * @throws Error when a command is not `tsc -p <project>`, naming the command.
 */
export function projectsOf(script: string): string[] {
  return script.split("&&").map((part) => {
    const command = part.trim();
    const project = /^tsc -p (\S+)$/u.exec(command)?.[1];
    if (project === undefined) {
      throw new Error(`the build script runs ${command}, not a tsc project`);
    }
    return project;
  });
}

/**
 * The tsconfig each command of the package's `build` script compiles, in script order, so a test
 * that builds a copy of the package builds what `npm run build` builds.
 *
 * @param root - The directory holding the `package.json` read; the repository root by default.
 * @returns Each project's path relative to `root`.
 * @throws Error when the manifest has no `build` script, or a command of it is not
 *   `tsc -p <project>`.
 * @throws SyntaxError when the manifest is not valid JSON.
 * @throws Error when the manifest cannot be read; the `readFileSync` system error passes through.
 */
export function buildProjects(root = ROOT): string[] {
  const manifest: unknown = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const scripts = isRecord(manifest) ? manifest["scripts"] : undefined;
  const build = isRecord(scripts) ? scripts["build"] : undefined;
  if (typeof build !== "string") throw new Error("package.json has no build script");
  return projectsOf(build);
}
