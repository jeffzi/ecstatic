import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { transform } from "esbuild";
import type { Plugin } from "vitest/config";

const GOLDEN_SUFFIX = ".golden";

/** The source file each runtime import a golden makes resolves to. */
const RUNTIME_SOURCES: ReadonlyMap<string, string> = new Map([
  ["ecstatic", fileURLToPath(new URL("../../src/index.ts", import.meta.url))],
  ["ecstatic/internal", fileURLToPath(new URL("../../src/internal.ts", import.meta.url))],
]);

/**
 * A Vite plugin that makes `expected.ts.golden` files importable as TypeScript modules.
 *
 * Vite's `tsconfigPaths` and its `.js` → `.ts` rewrite both skip importers that are not
 * TypeScript files, so a golden's imports are resolved here: `ecstatic` and `ecstatic/internal`
 * map to the sources, and every other import resolves as it would from the `.ts` file the golden
 * is named after.
 *
 * @returns The plugin, for a Vitest project's `plugins`.
 */
export function goldenLoader(): Plugin {
  return {
    name: "ecstatic-golden-loader",
    enforce: "pre",
    resolveId(source, importer) {
      if (importer?.endsWith(GOLDEN_SUFFIX) !== true) {
        return null;
      }
      const namesake = importer.slice(0, -GOLDEN_SUFFIX.length);
      return RUNTIME_SOURCES.get(source) ?? this.resolve(source, namesake, { skipSelf: true });
    },
    async load(id) {
      if (!id.endsWith(GOLDEN_SUFFIX)) {
        return null;
      }
      const text = await readFile(id, "utf8");
      try {
        const { code } = await transform(text, { loader: "ts", format: "esm", sourcefile: id });
        return code;
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        throw new Error(`cannot transpile golden ${id}: ${reason}`, { cause: error });
      }
    },
  };
}
