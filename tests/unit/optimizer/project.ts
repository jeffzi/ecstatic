import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";

/** The repository's compiler options, so the runtime sources type-check in a project as they do here. */
export const RUNTIME_TSCONFIG = `{
  "compilerOptions": {
    "strict": true,
    "target": "es2024",
    "lib": ["es2024"],
    "module": "nodenext",
    "exactOptionalPropertyTypes": true,
    "noUncheckedIndexedAccess": true,
    "allowUnreachableCode": false,
    "allowUnusedLabels": false,
    "noImplicitOverride": true,
    "noImplicitReturns": true,
    "noFallthroughCasesInSwitch": true,
    "noPropertyAccessFromIndexSignature": true,
    "verbatimModuleSyntax": true,
    "isolatedModules": true,
    "esModuleInterop": true,
    "noEmit": true,
    "skipLibCheck": true,
    "types": []
  },
  "include": ["**/*.ts"]
}`;

const REPO_SOURCES = fileURLToPath(new URL("../../../src/", import.meta.url));

/** The bundler plugin's directory under `src/`, which the runtime build leaves out. */
const PLUGIN_DIR = "plugin";

const written: string[] = [];

/**
 * A strict, non-emitting tsconfig for a project whose sources sit under `app/`.
 *
 * @param extraOptions - Compiler options added to the shared ones.
 * @returns The tsconfig's JSON text.
 */
export function appTsconfig(extraOptions: Readonly<Record<string, unknown>> = {}): string {
  return JSON.stringify({
    compilerOptions: {
      strict: true,
      target: "es2024",
      module: "nodenext",
      noEmit: true,
      types: [],
      ...extraOptions,
    },
    include: ["app/**/*.ts"],
  });
}

/**
 * Writes `files`, keyed by slash-separated path, under a new temp directory.
 *
 * @param files - File contents keyed by their path relative to the project directory.
 * @returns The project directory's real path, so it matches the file names the compiler reports.
 */
export function writeProject(files: Readonly<Record<string, string>>): string {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), "ecstatic-project-"));
  written.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    const path = join(dir, ...rel.split("/"));
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }
  return dir;
}

/** Deletes every directory {@link writeProject} created. */
export function removeProjects(): void {
  for (const dir of written.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * The repository's runtime sources as a project: its `src/` without the bundler plugin, a tsconfig
 * holding {@link RUNTIME_TSCONFIG}, and a manifest named `ecstatic`, plus `extra`.
 */
export function runtimeProject(
  extra: Readonly<Record<string, string>> = {},
): Record<string, string> {
  const files: Record<string, string> = {
    "tsconfig.json": RUNTIME_TSCONFIG,
    "package.json": `{"name": "ecstatic", "type": "module"}`,
  };
  const sources = readdirSync(REPO_SOURCES, { recursive: true, encoding: "utf8" });
  for (const rel of sources) {
    if (!rel.endsWith(".ts") || rel.startsWith(PLUGIN_DIR + sep)) continue;
    files[`src/${rel.split(sep).join("/")}`] = readFileSync(join(REPO_SOURCES, rel), "utf8");
  }
  return { ...files, ...extra };
}
