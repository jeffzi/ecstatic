import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");

/** Narrows a parsed JSON value to a plain object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The tsconfig each command of the package's `build` script compiles, in script order, so a test
 * that builds a copy of the package builds what `npm run build` builds.
 *
 * @returns Each project's path relative to the repository root.
 * @throws Error when the manifest has no `build` script, or a command of it is not
 *   `tsc -p <project>`.
 * @throws SyntaxError when the manifest is not valid JSON.
 * @throws Error when the manifest cannot be read; the `readFileSync` system error passes through.
 */
export function buildProjects(): string[] {
  const manifest: unknown = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  const scripts = isRecord(manifest) ? manifest["scripts"] : undefined;
  const build = isRecord(scripts) ? scripts["build"] : undefined;
  if (typeof build !== "string") throw new Error("package.json has no build script");
  return build.split("&&").map((part) => {
    const command = part.trim();
    const project = /^tsc -p (\S+)$/u.exec(command)?.[1];
    if (project === undefined) {
      throw new Error(`the build script runs ${command}, not a tsc project`);
    }
    return project;
  });
}
