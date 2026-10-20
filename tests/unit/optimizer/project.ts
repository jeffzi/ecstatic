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

import {
  openSession,
  type ProjectView,
  type Session,
} from "../../../src/plugin/optimizer/session.js";

/** How long opening a compiler session may take on a slow CI runner. */
export const SPAWN_TIMEOUT_MS = 30_000;

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

const RUNTIME_SOURCES = fileURLToPath(new URL("../../../src/ecstatic/", import.meta.url));

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

/** The absolute path of the slash-separated `rel` under `dir`. */
export function projectPath(dir: string, rel: string): string {
  return join(dir, ...rel.split("/"));
}

/**
 * Case files for `sources`: the file at `${stem}${index}.ts` holds `header` followed by the source
 * at that index.
 *
 * @param stem - The slash-separated path prefix of every case file, before its index.
 * @param sources - The case sources, one file each.
 * @param header - Text written at the start of every case file.
 * @returns The files keyed by slash-separated path, ready for {@link writeProject}.
 */
export function caseFiles(
  stem: string,
  sources: readonly string[],
  header = "",
): Record<string, string> {
  return Object.fromEntries(sources.map((source, i) => [`${stem}${i}.ts`, header + source]));
}

/** A written project with the session opened on its `tsconfig.json`. */
export interface OpenProject {
  readonly root: string;
  readonly session: Session;
  /** The session's view of the project as written. */
  readonly view: ProjectView;
}

/**
 * Writes `files` and opens a session on the project's `tsconfig.json`.
 *
 * @param files - File contents keyed by slash-separated path; one of them is `tsconfig.json`.
 * @returns The project directory, its session, and the session's first view.
 */
export async function openProject(files: Readonly<Record<string, string>>): Promise<OpenProject> {
  const root = writeProject(files);
  const session = await openSession(join(root, "tsconfig.json"));
  try {
    return { root, session, view: await session.update() };
  } catch (error) {
    await session.close();
    throw error;
  }
}

/** Closes `session` and deletes every project written. */
export async function closeProject(session: Session): Promise<void> {
  await session.close();
  removeProjects();
}

/** The `app/` files that declare the components and archetypes the analysis cases share. */
export const SHARED_ARCHETYPE_FILES: Readonly<Record<string, string>> = {
  "app/position.ts": `import { component } from "../src/ecstatic/index.js";

export const Position = component("Position", { x: 0, y: 0 });
`,
  "app/components.ts": `import { component, f32, ref, relation } from "../src/ecstatic/index.js";

export const Velocity = component("Velocity", { dx: f32(0), dy: 0 });
export const Shield = component("Shield", { hp: 0, active: true, label: "", owner: ref<number>() });
export const Stunned = component("Stunned");
export const Boost = component("Boost", {});
export const ChildOf = relation("ChildOf", { order: 0, pinned: false });
`,
  "app/archetypes.ts": `import { Archetype, archetype } from "../src/ecstatic/index.js";
import { Boost, ChildOf, Shield, Stunned, Velocity } from "./components.js";
import { Position } from "./position.js";

export const Enemy = archetype([Position, Velocity], [Shield, Stunned]);
export class Ship extends Archetype([Position], [Shield, Stunned, Boost]) {}
export class Hull extends Archetype([Position], [Shield, Stunned, Boost]) {}
export const Linked = archetype([Position, ChildOf]);
`,
};

/**
 * The repository's runtime laid out as the package lays it out: the runtime sources from
 * `src/ecstatic/` copied at the same relative path in the project, beside a tsconfig holding
 * {@link RUNTIME_TSCONFIG} and a manifest named `ecstatic`.
 *
 * @param extra - Files added to the project, keyed by slash-separated path; an entry replaces a
 *   runtime or generated file at the same path.
 * @returns The project's files keyed by slash-separated path, ready for {@link writeProject}.
 */
export function runtimeProject(
  extra: Readonly<Record<string, string>> = {},
): Record<string, string> {
  const files: Record<string, string> = {
    "tsconfig.json": RUNTIME_TSCONFIG,
    "package.json": `{"name": "ecstatic", "type": "module"}`,
  };
  const sources = readdirSync(RUNTIME_SOURCES, { recursive: true, encoding: "utf8" });
  for (const rel of sources) {
    if (!rel.endsWith(".ts")) continue;
    files[`src/ecstatic/${rel.split(sep).join("/")}`] = readFileSync(
      join(RUNTIME_SOURCES, rel),
      "utf8",
    );
  }
  return { ...files, ...extra };
}
