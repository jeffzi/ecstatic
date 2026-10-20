import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, it } from "vitest";

import { removeProjects, RUNTIME_TSCONFIG, runtimeProject, writeProject } from "./project.js";

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

/** Emit settings of the build config that a type-check-only project leaves out. */
const EMIT_ONLY = new Set(["rootDir", "outDir", "declaration", "declarationMap", "sourceMap"]);

afterAll(removeProjects);

/** The `compilerOptions` of the tsconfig `text`, with string values lowercased. */
function compilerOptions(text: string): Record<string, unknown> {
  const { compilerOptions: options }: { compilerOptions: Record<string, unknown> } =
    JSON.parse(text);
  const lowered = (value: unknown): unknown => {
    if (typeof value === "string") return value.toLowerCase();
    return Array.isArray(value) ? value.map(lowered) : value;
  };
  return Object.fromEntries(Object.entries(options).map(([key, value]) => [key, lowered(value)]));
}

function repositoryConfig(name: string): string {
  return readFileSync(join(REPO_ROOT, name), "utf8");
}

describe("writeProject", () => {
  it("writes each file, nested paths included, under one directory", () => {
    const files = { "tsconfig.json": "{}", "src/deep/main.ts": "export {};\n" };

    const dir = writeProject(files);

    expect(readFileSync(join(dir, "tsconfig.json"), "utf8")).toBe("{}");
    expect(readFileSync(join(dir, "src", "deep", "main.ts"), "utf8")).toBe("export {};\n");
  });
});

describe("runtimeProject", () => {
  it("holds the runtime sources without the bundler plugin, plus the extra files", () => {
    const files = runtimeProject({ "app/main.ts": "export {};\n" });

    const plugin = Object.keys(files).filter((rel) => rel.startsWith("src/plugin/"));

    expect(files["src/index.ts"]).toBe(readFileSync(join(REPO_ROOT, "src", "index.ts"), "utf8"));
    expect(files["app/main.ts"]).toBe("export {};\n");
    expect(files["tsconfig.json"]).toBe(RUNTIME_TSCONFIG);
    expect(plugin).toStrictEqual([]);
  });

  it("mirrors the build's compiler options, type-checking only", () => {
    const build = {
      ...compilerOptions(repositoryConfig("tsconfig.json")),
      ...compilerOptions(repositoryConfig("tsconfig.build.json")),
      noEmit: true,
    };
    const expected = Object.fromEntries(Object.entries(build).filter(([k]) => !EMIT_ONLY.has(k)));

    const actual = compilerOptions(RUNTIME_TSCONFIG);

    expect(actual).toStrictEqual(expected);
  });
});
