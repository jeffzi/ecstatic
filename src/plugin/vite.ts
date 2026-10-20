/**
 * The ecstatic Vite plugin: rewrites the `each()` calls of every module the project's program holds
 * into inlined loops, before Vite strips the module's types.
 */
import { resolve } from "node:path";

import type { EnvironmentModuleNode, Plugin, Rolldown } from "vite";

import { fileKey } from "./file-key.js";
import { bailDiagnostics } from "./optimizer/diagnostics.js";
import type { RewrittenModule } from "./optimizer/rewrite.js";
import type { ServedProject } from "./served-project.js";

/** Options of {@link ecstatic}. */
export interface EcstaticOptions {
  /** The tsconfig whose program the plugin rewrites, resolved from Vite's root; `tsconfig.json` when absent. */
  readonly project?: string;
  /** Whether a call that cannot be optimized fails the module's transform; `false` when absent. */
  readonly strict?: boolean;
}

const OPTION_KEYS: ReadonlySet<string> = new Set(["project", "strict"]);

const DEFAULT_PROJECT = "tsconfig.json";

/**
 * Creates the ecstatic Vite plugin.
 *
 * One plugin instance keeps one compiler process from its first build start until the build ends,
 * the watcher of a watch build closes, or the dev server closes.
 *
 * @param options - Which project to rewrite and how to report calls that cannot be optimized.
 * @returns The plugin.
 * @throws TypeError when `options` holds a key other than `project` and `strict`, or a `strict` that
 *   is not a boolean.
 */
export default function ecstatic(options: EcstaticOptions = {}): Plugin {
  checkOptions(options);
  const strict = options.strict ?? false;
  let root = process.cwd();
  let serving = false;
  let project: ServedProject | undefined;
  /** The {@link fileKey} of each file a module's latest rewrite consulted, keyed by module id. */
  const consultedBy = new Map<string, ReadonlySet<string>>();
  const close = async (): Promise<void> => {
    const closing = project;
    project = undefined;
    consultedBy.clear();
    await closing?.close();
  };
  return {
    name: "ecstatic",
    enforce: "pre",
    configResolved(config) {
      root = config.root;
      serving = config.command === "serve";
    },
    async buildStart() {
      // A watch build starts each rebuild here, and keeps the project it opened.
      if (project !== undefined) return;
      const tsconfig = resolve(root, options.project ?? DEFAULT_PROJECT);
      const openProject = await loadOptimizer();
      project = await openProject(tsconfig);
      if (project.rewritableCount === 0) {
        this.warn(
          `the program of ${tsconfig} holds no source files, so ecstatic rewrites nothing; set the plugin's project option to the tsconfig that compiles the app`,
        );
      }
    },
    async transform(code, id) {
      if (project === undefined || id.includes("?")) return undefined;
      const file = project.programFile(id);
      if (file === undefined) return undefined;
      const rewritten = await project.rewrite(file, code);
      consultedBy.set(id, new Set(rewritten.consulted.map(fileKey)));
      for (const consulted of rewritten.consulted) this.addWatchFile(consulted);
      reportBails(this, id, rewritten, strict);
      const { output } = rewritten;
      return output === undefined ? undefined : { code: output.text, map: output.map };
    },
    async watchChange(id, { event }) {
      await project?.changed(id, event);
    },
    hotUpdate({ file, modules }) {
      const dependents = dependentModules(consultedBy, file, (id) =>
        this.environment.moduleGraph.getModuleById(id),
      ).filter((node) => !modules.includes(node));
      // Each returned module is invalidated outright, so the dev server transforms it again rather
      // than reusing its rewrite with only its imports refreshed.
      return dependents.length === 0 ? undefined : [...modules, ...dependents];
    },
    async closeBundle() {
      // A watch build closes a bundle at each rebuild; its watcher's close ends the project.
      if (serving || !this.meta.watchMode) await close();
    },
    async closeWatcher() {
      await close();
    },
  };
}

/**
 * The modules whose latest rewrite consulted `file`.
 *
 * @param consultedBy - The files each module's latest rewrite consulted, by {@link fileKey}, keyed
 *   by module id.
 * @param file - The changed file.
 * @param moduleById - The dev server's module of an id, or undefined when it has none.
 * @returns The dev server's modules of the dependents.
 */
function dependentModules(
  consultedBy: ReadonlyMap<string, ReadonlySet<string>>,
  file: string,
  moduleById: (id: string) => EnvironmentModuleNode | undefined,
): EnvironmentModuleNode[] {
  const key = fileKey(file);
  const dependents: EnvironmentModuleNode[] = [];
  for (const [id, consulted] of consultedBy) {
    const node = consulted.has(key) ? moduleById(id) : undefined;
    if (node !== undefined) dependents.push(node);
  }
  return dependents;
}

/**
 * Reports the bails of a module's rewrite: as warnings at their calls, or under strict, when any is
 * reported, as one error listing every one.
 *
 * @param context - The transform's plugin context.
 * @param id - The module's id.
 * @param rewritten - The module's rewrite.
 * @param strict - Whether the plugin runs under strict.
 * @throws The error listing the module's bails, under strict.
 */
function reportBails(
  context: Pick<Rolldown.TransformPluginContext, "warn" | "error">,
  id: string,
  rewritten: RewrittenModule,
  strict: boolean,
): void {
  const { bails, fileBail } = rewritten;
  const diagnostics = bailDiagnostics(
    fileBail === undefined ? bails : [...bails, fileBail],
    strict,
  );
  if (strict) {
    if (diagnostics.length === 0) return;
    const listed = diagnostics.map(
      ({ message, line, column }) => `${id}:${line}:${column}: ${message}`,
    );
    context.error(listed.join("\n"));
  }
  for (const { message, line, column } of diagnostics) {
    // Vite's locations count lines from 1 and columns from 0.
    context.warn({ message, loc: { file: id, line, column: column - 1 } });
  }
}

/**
 * Checks the options a JavaScript config may hand {@link ecstatic} unchecked.
 *
 * @param options - The options given to the plugin.
 * @throws TypeError naming the offending key and listing the valid ones.
 */
function checkOptions(options: object): void {
  const valid = `the valid options are ${[...OPTION_KEYS].join(", ")}`;
  for (const key of Object.keys(options)) {
    if (!OPTION_KEYS.has(key)) throw new TypeError(`ecstatic: unknown option "${key}"; ${valid}`);
  }
  if ("strict" in options && typeof options.strict !== "boolean") {
    throw new TypeError(`ecstatic: the option "strict" must be a boolean; ${valid}`);
  }
}

/**
 * Loads the optimizer, which needs the TypeScript 7.1 API. It loads at build start, so a missing or
 * older `typescript` fails the build naming the cause rather than failing the config's import.
 *
 * @returns The function that opens the project.
 * @throws Error naming a missing `typescript`, one without `typescript/async`, or whatever else kept
 *   the optimizer from loading.
 */
async function loadOptimizer(): Promise<typeof import("./served-project.js").openProject> {
  try {
    const { openProject } = await import("./served-project.js");
    return openProject;
  } catch (error) {
    throw new Error(loadFailure(error), { cause: error });
  }
}

/**
 * Words why the optimizer failed to load, from the module loader's error. A loader that wraps the
 * error keeps it as a cause, so the chain is searched for it.
 *
 * @param error - What importing the optimizer threw.
 * @returns The message naming the cause.
 */
function loadFailure(error: unknown): string {
  let cause: unknown = error;
  while (cause instanceof Error) {
    const code = "code" in cause ? cause.code : undefined;
    const detail = `(${cause.message})`;
    if (code === "ERR_MODULE_NOT_FOUND" && cause.message.includes("'typescript'")) {
      return `ecstatic: the optimizer needs the \`typescript\` package, 7.1 or later, which is not installed ${detail}`;
    }
    if (
      code === "ERR_PACKAGE_PATH_NOT_EXPORTED" &&
      /[\\/]typescript[\\/]package\.json/u.test(cause.message)
    ) {
      return `ecstatic: the installed \`typescript\` has no \`typescript/async\` export; the optimizer needs 7.1 or later ${detail}`;
    }
    ({ cause } = cause);
  }
  return `ecstatic: cannot load the optimizer (${String(error)})`;
}
