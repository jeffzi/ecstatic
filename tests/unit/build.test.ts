import { execFile } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import { packageBin } from "../package-bin.js";

const execFileAsync = promisify(execFile);

const ROOT = resolve(import.meta.dirname, "../..");

const PLUGIN_DIR = join(ROOT, "src", "plugin");

const NODE_TYPES_DIR = join("node_modules", "@types", "node");

/** The absolute paths of every file `tsc` compiles for the project at `tsconfig`. */
async function compiledFiles(tsconfig: string): Promise<string[]> {
  const { stdout } = await execFileAsync(
    process.execPath,
    [packageBin("typescript", "tsc"), "--listFilesOnly", "-p", tsconfig],
    { cwd: ROOT },
  );
  return stdout
    .split(/\r?\n/)
    .filter((line) => line !== "")
    .map((file) => resolve(file));
}

/** The absolute paths of every TypeScript module under `src/plugin/`. */
function pluginModules(): string[] {
  return readdirSync(PLUGIN_DIR, { recursive: true, encoding: "utf8" })
    .filter((file) => file.endsWith(".ts"))
    .map((file) => join(PLUGIN_DIR, file));
}

/** The `&&`-separated commands of the package script `name`. */
function packageScript(name: string): string[] {
  const { scripts }: { scripts: Record<string, string> } = JSON.parse(
    readFileSync(join(ROOT, "package.json"), "utf8"),
  );
  return (scripts[name] ?? "").split("&&").map((command) => command.trim());
}

describe("build", () => {
  describe("runtime project", () => {
    it("compiles neither a plugin module nor the Node types", async () => {
      const files = await compiledFiles("tsconfig.build.json");

      const leaked = files.filter(
        (file) => file.startsWith(PLUGIN_DIR) || file.includes(NODE_TYPES_DIR),
      );

      expect(files).toContain(join(ROOT, "src", "index.ts"));
      expect(leaked).toStrictEqual([]);
    });
  });

  describe("plugin project", () => {
    it("compiles every plugin module with the Node types", async () => {
      const files = await compiledFiles("tsconfig.build-plugin.json");

      const compiled = new Set(files);
      expect(pluginModules().filter((file) => !compiled.has(file))).toStrictEqual([]);
      expect(files.some((file) => file.includes(NODE_TYPES_DIR))).toBe(true);
    });
  });

  describe("package scripts", () => {
    it.each([
      {
        script: "build",
        commands: ["tsc -p tsconfig.build.json", "tsc -p tsconfig.build-plugin.json"],
      },
      {
        script: "check:type",
        commands: [
          "tsc -p tsconfig.build.json --noEmit",
          "tsc -p tsconfig.build-plugin.json --noEmit",
        ],
      },
    ])("$script runs the runtime project, then the plugin project", ({ script, commands }) => {
      const actual = packageScript(script);

      expect(actual.filter((command) => commands.includes(command))).toStrictEqual(commands);
    });
  });
});
