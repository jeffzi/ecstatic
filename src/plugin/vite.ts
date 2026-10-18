/**
 * The Vite plugin, imported as `ecstatic/vite`: ttsc's Vite adapter running the project's own
 * tsconfig plugin list, guarded by a check that the list enables ecstatic.
 */

import type { TtscUnpluginOptions } from "@ttsc/unplugin/api";
import ttscVite from "@ttsc/unplugin/vite";

import { assertPluginEntry, type PluginEntryCheck, pluginEntryCheck } from "./plugin-entry.js";

/**
 * Options for the ecstatic bundler plugins.
 *
 * There is no `plugins` or `compilerOptions` option: the ttsc plugin list always comes from the
 * project's tsconfig, which is the list the entry check reads.
 */
export interface EcstaticBundlerOptions {
  /**
   * The tsconfig to compile with; a relative path resolves from the working directory. Omitted,
   * each module uses its nearest tsconfig.
   */
  readonly project?: string;
  /** Common source root for a tsconfig that includes sibling workspace packages. */
  readonly projectRoot?: string;
  /** Source entries whose projects start compiling on the first load. */
  readonly precompile?: readonly string[];
}

type TtscVitePlugin = ReturnType<typeof ttscVite>;

function ttscOptions({
  project,
  projectRoot,
  precompile,
}: EcstaticBundlerOptions): TtscUnpluginOptions {
  return {
    ...(project !== undefined && { project }),
    ...(projectRoot !== undefined && { projectRoot }),
    ...(precompile !== undefined && { precompile }),
  };
}

/**
 * Build the ecstatic Vite plugin.
 *
 * @param options - Which tsconfig to compile with; see {@link EcstaticBundlerOptions}.
 * @returns With `project`, the ttsc Vite plugin. Without it, the entry-check plugin followed by
 *   the ttsc Vite plugin, since each module's tsconfig is only known once it is transformed.
 * @throws When `project` is given and its effective plugin list lacks the ecstatic entry, or
 *   cannot be read (see {@link assertPluginEntry}).
 */
export default function ecstatic(
  options: EcstaticBundlerOptions = {},
): TtscVitePlugin | [PluginEntryCheck, TtscVitePlugin] {
  if (options.project !== undefined) {
    assertPluginEntry(options.project);
    return ttscVite(ttscOptions(options));
  }
  return [pluginEntryCheck(), ttscVite(ttscOptions(options))];
}
