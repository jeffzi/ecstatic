/**
 * Checks that a tsconfig enables the ecstatic optimizer, for the bundler subpaths.
 *
 * The bundler adapters run the project's own `compilerOptions.plugins` list, so a project that
 * forgot the ecstatic entry would build unoptimized without a word. These checks turn that
 * into an error naming the tsconfig. Configs are read with ttsc's own JSONC grammar and
 * `extends` resolution, so the check and the compiler cannot disagree about what a config says.
 */

// oxlint-disable-next-line import/no-nodejs-modules -- build-time bundler plugin; runs only under Node, never bundled into the runtime
import { existsSync, readFileSync, realpathSync } from "node:fs";
// oxlint-disable-next-line import/no-nodejs-modules -- build-time bundler plugin; runs only under Node, never bundled into the runtime
import { dirname, isAbsolute, join, resolve } from "node:path";

import {
  discoverNearestProjectTsconfig,
  isTransformTarget,
  selectReferencedProject,
} from "@ttsc/unplugin/api";
import { isRelativePluginSpecifier, parseJsonc, resolveTsconfigExtends } from "ttsc/tsconfig";

/** Must match the `./optimizer` subpath in package.json `exports`, as `ecstatic/optimizer`. */
const DESCRIPTOR_SUBPATH = "ecstatic/optimizer";

/** This module sits in `src/plugin/` or `dist/plugin/`, two levels below the package root. */
const PACKAGE_ROOT = resolve(import.meta.dirname, "..", "..");

/** The descriptor as shipped: its source and its build. Either may be absent. */
const DESCRIPTOR_FILES = [
  join(PACKAGE_ROOT, "src", "plugin", "optimizer.ts"),
  join(PACKAGE_ROOT, "dist", "plugin", "optimizer.js"),
];

/** A path-valued `transform` is tried as written, then as the descriptor's source, then its build. */
const TRANSFORM_PATH_SUFFIXES = ["", ".ts", ".js"];

/**
 * Query keys that make a module a host-generated wrapper around a file (`?raw`, `?url`, a worker
 * constructor, an inlined asset) rather than the file's program, so the ttsc plugin leaves it
 * untransformed. Keep in step with `HOST_WRAPPER_QUERY_KEYS` in
 * `@ttsc/unplugin/lib/core/transform/utils/isHostWrapperQuery.mjs`, which the package does not
 * export.
 */
const HOST_WRAPPER_QUERY_KEYS: ReadonlySet<string> = new Set([
  "inline",
  "no-inline",
  "raw",
  "sharedworker",
  "url",
  "worker",
]);

/** A plugin list and the config that declared it, which anchors its relative paths. */
interface DeclaredPlugins {
  readonly entries: unknown;
  readonly declaredIn: string;
}

/** The entry-check plugin the bundler subpaths put before the ttsc plugin. */
export interface PluginEntryCheck {
  readonly name: string;
  readonly enforce: "pre";
  transform(code: string, id: string): void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function field(value: unknown, key: string): unknown {
  return isRecord(value) ? value[key] : undefined;
}

/**
 * Read and parse one config of an `extends` chain.
 *
 * @param tsconfig - Absolute path of the config to read.
 * @returns The config's root object.
 * @throws When the file cannot be read, is not valid JSONC, or its root value is not an object,
 *   naming the file.
 */
function readConfig(tsconfig: string): Record<string, unknown> {
  let config: unknown;
  try {
    config = parseJsonc(readFileSync(tsconfig, "utf8"));
  } catch (cause) {
    throw new Error(`ecstatic: cannot read ${tsconfig}: ${String(cause)}`, { cause });
  }
  if (!isRecord(config)) {
    throw new Error(`ecstatic: ${tsconfig} must hold a JSON object at its root`);
  }
  return config;
}

/**
 * The `extends` specifiers a config declares, in declaration order.
 *
 * @param config - The config's root object.
 * @param tsconfig - Absolute path of the config, for the error message.
 * @returns The specifiers; empty when the config declares no `extends`.
 * @throws When `extends` is neither a string nor an array of strings, naming the file.
 */
function extendsSpecifiers(config: Record<string, unknown>, tsconfig: string): readonly string[] {
  const value = config["extends"];
  if (value === undefined) return [];
  if (typeof value === "string") return [value];
  if (
    Array.isArray(value) &&
    value.every((specifier): specifier is string => typeof specifier === "string")
  ) {
    return value;
  }
  throw new Error(
    `ecstatic: ${tsconfig} has an "extends" that is not a string or an array of strings`,
  );
}

function resolveExtends(tsconfig: string, specifier: string): string {
  try {
    return resolveTsconfigExtends(tsconfig, specifier);
  } catch (cause) {
    throw new Error(`ecstatic: cannot resolve extends of ${tsconfig}: ${String(cause)}`, {
      cause,
    });
  }
}

/** A config on the path from the checked tsconfig to the one being read. */
interface ChainLink {
  readonly file: string;
  readonly realFile: string;
}

/**
 * The plugin list in effect for a tsconfig, following `extends` the way the compiler merges it:
 * the config's own `compilerOptions.plugins` wins, otherwise the last base declaring one.
 * Every base is read, in declaration order, so a broken one fails the check even when a later
 * base would have supplied the list.
 *
 * A base reached twice through different `extends` entries is not a cycle; only a base that is
 * already on the path from the checked tsconfig is, compared by real path so a symlink cannot
 * hide one.
 *
 * @param tsconfig - Absolute path of the config to read.
 * @param ancestors - The configs extending this one, nearest last.
 * @returns The winning list and the config declaring it, or `undefined` when no config in the
 *   chain declares `compilerOptions.plugins`.
 * @throws When a config in the chain cannot be read or parsed, its root value is not an object,
 *   its `extends` is malformed or cannot be resolved, or the chain is cyclic.
 */
function effectivePlugins(
  tsconfig: string,
  ancestors: readonly ChainLink[] = [],
): DeclaredPlugins | undefined {
  const config = readConfig(tsconfig);
  const chain = [...ancestors, { file: tsconfig, realFile: realpathSync(tsconfig) }];
  let inherited: DeclaredPlugins | undefined;
  for (const specifier of extendsSpecifiers(config, tsconfig)) {
    const base = resolveExtends(tsconfig, specifier);
    const realBase = realpathSync(base);
    if (chain.some((link) => link.realFile === realBase)) {
      const path = [...chain.map((link) => link.file), base].join(" -> ");
      throw new Error(`ecstatic: the extends chain is cyclic: ${path}`);
    }
    inherited = effectivePlugins(base, chain) ?? inherited;
  }
  const entries = field(config["compilerOptions"], "plugins");
  return entries === undefined ? inherited : { entries, declaredIn: tsconfig };
}

function namesDescriptorFile(transform: string, declaredIn: string): boolean {
  if (!isRelativePluginSpecifier(transform) && !isAbsolute(transform)) return false;
  const descriptors = new Set(
    DESCRIPTOR_FILES.filter(existsSync).map((file) => realpathSync(file)),
  );
  const base = resolve(dirname(declaredIn), transform);
  return TRANSFORM_PATH_SUFFIXES.some((suffix) => {
    const candidate = base + suffix;
    return existsSync(candidate) && descriptors.has(realpathSync(candidate));
  });
}

function isDescriptorEntry(entry: unknown, declaredIn: string): boolean {
  // ttsc skips an entry whose `enabled` is exactly `false`, so such an entry transforms nothing.
  if (field(entry, "enabled") === false) return false;
  const transform = field(entry, "transform");
  return (
    transform === DESCRIPTOR_SUBPATH ||
    (typeof transform === "string" && namesDescriptorFile(transform, declaredIn))
  );
}

/**
 * Check that a tsconfig's effective `compilerOptions.plugins` includes the ecstatic descriptor,
 * named as `ecstatic/optimizer` or by a path to this package's descriptor, in an entry that is not
 * disabled with `"enabled": false`.
 *
 * @param tsconfig - The tsconfig to check; a relative path resolves from the working directory.
 * @throws When no effective plugin entry is the ecstatic descriptor, naming the tsconfig and
 *   suggesting the `project` option.
 * @throws When the tsconfig or a config it extends is missing, unreadable, not valid JSONC, or
 *   not a JSON object, or its `extends` is not a string or an array of strings or cannot be
 *   resolved, naming that file and the cause.
 * @throws When the `extends` chain is cyclic, naming the configs in the cycle.
 */
export function assertPluginEntry(tsconfig: string): void {
  const file = resolve(tsconfig);
  const declared = effectivePlugins(file);
  if (declared !== undefined && Array.isArray(declared.entries)) {
    const { entries, declaredIn } = declared;
    if (entries.some((entry) => isDescriptorEntry(entry, declaredIn))) return;
  }
  throw new Error(
    `ecstatic: ${file} has no compilerOptions.plugins entry for the ecstatic optimizer. ` +
      `Add { "transform": "${DESCRIPTOR_SUBPATH}" } to its plugins, or pass \`project\` ` +
      `to the ecstatic bundler plugin to pin the tsconfig that has one.`,
  );
}

/**
 * The tsconfig the ttsc bundler plugin compiles a file with when no `project` is given.
 *
 * @param file - Absolute path of the transformed module.
 * @returns The selected tsconfig's path.
 */
function selectProject(file: string): string {
  const nearest = discoverNearestProjectTsconfig(dirname(file)).file;
  if (nearest === undefined) return resolve("tsconfig.json");
  return selectReferencedProject(file, nearest).tsconfig;
}

/**
 * Strip a bundler module id's `?query` or `#hash`, as the ttsc plugin does before choosing files.
 *
 * @param id - The module id the bundler passes to `transform`.
 * @returns The file path part of the id.
 */
function stripQuery(id: string): string {
  const query = id.search(/[?#]/);
  return query === -1 ? id : id.slice(0, query);
}

/**
 * Whether a bundler module id is a host-generated wrapper the ttsc plugin does not transform. A
 * `#hash` before the `?query` puts the query inside the fragment, where it names no wrapper.
 *
 * @param id - The module id the bundler passes to `transform`.
 * @returns Whether the id's query carries a key in {@link HOST_WRAPPER_QUERY_KEYS}.
 */
function isHostWrapper(id: string): boolean {
  const queryStart = id.indexOf("?");
  const hashStart = id.indexOf("#");
  if (queryStart === -1 || (hashStart !== -1 && hashStart < queryStart)) return false;
  const query = id.slice(queryStart + 1, hashStart === -1 ? undefined : hashStart);
  for (const key of new URLSearchParams(query).keys()) {
    if (HOST_WRAPPER_QUERY_KEYS.has(key)) return true;
  }
  return false;
}

/**
 * Build the plugin that checks, for each module the ttsc plugin transforms, the tsconfig it
 * compiles that module with: the nearest tsconfig, then the referenced project that compiles
 * the file, then `tsconfig.json` in the working directory.
 *
 * Each tsconfig that passes is not checked again by the same plugin instance.
 *
 * @returns The entry-check plugin; its `transform` hook throws as {@link assertPluginEntry} does.
 */
export function pluginEntryCheck(): PluginEntryCheck {
  const passed = new Set<string>();
  return {
    name: "ecstatic:plugin-entry",
    enforce: "pre",
    transform(_code: string, id: string): void {
      if (isHostWrapper(id)) return;
      const file = stripQuery(id);
      if (!isTransformTarget(file)) return;
      const tsconfig = selectProject(file);
      if (passed.has(tsconfig)) return;
      assertPluginEntry(tsconfig);
      passed.add(tsconfig);
    },
  };
}
