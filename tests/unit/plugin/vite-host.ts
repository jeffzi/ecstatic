/** Drives a Vite plugin's build hooks by hand, as a Vite build calls them. */
import { resolveConfig, type Plugin } from "vite";

/** A plugin started as a Vite build starts it, with the warnings it reported. */
export interface Host {
  /** The text of each warning, in the order reported. */
  readonly warnings: string[];
  /** Each warning as the plugin passed it to `this.warn`, in the order reported. */
  readonly logs: unknown[];
  transform(code: string, id: string): Promise<unknown>;
  /** Starts the build's plugin hooks again, as a watch build does at each rebuild. */
  buildStart(): Promise<void>;
  /** Reports that the file `id` changed on disk, as a watch build's watcher does. */
  watchChange(id: string, event: "create" | "update" | "delete"): Promise<void>;
  close(): Promise<void>;
}

/** What one transform returned, with the warnings it reported. */
export interface Transformed {
  readonly result: unknown;
  readonly logs: readonly unknown[];
}

/** The text of a warning a plugin reports through `this.warn`. */
function warningText(warning: unknown): string {
  if (typeof warning === "string") return warning;
  if (
    typeof warning === "object" &&
    warning !== null &&
    "message" in warning &&
    typeof warning.message === "string"
  ) {
    return warning.message;
  }
  return JSON.stringify(warning);
}

/** Calls `hook`, in the function or the object form Vite accepts, with `context` as `this`. */
async function callHook(hook: unknown, context: object, ...args: unknown[]): Promise<unknown> {
  const handler =
    typeof hook === "object" && hook !== null && "handler" in hook ? hook.handler : hook;
  if (typeof handler !== "function") return undefined;
  const result: unknown = await Reflect.apply(handler, context, args);
  return result;
}

/**
 * Resolves a Vite config rooted at `root` holding `plugin`, then starts the build's plugin hooks.
 *
 * @param root - The Vite root.
 * @param plugin - The plugin under test.
 * @returns The started plugin, whose `close` ends the build.
 * @throws Error when the plugin's `buildStart` fails.
 */
export async function startPlugin(root: string, plugin: Plugin): Promise<Host> {
  const warnings: string[] = [];
  const logs: unknown[] = [];
  const context = {
    meta: { watchMode: false },
    // A build's environment, which every hook of a Vite plugin sees as `this.environment`.
    environment: { mode: "build" },
    warn: (warning: unknown): void => {
      warnings.push(warningText(warning));
      logs.push(warning);
    },
    error: (error: unknown): never => {
      throw error instanceof Error ? error : new Error(warningText(error));
    },
    addWatchFile: (): void => {},
  };
  await resolveConfig({ root, configFile: false, logLevel: "silent", plugins: [plugin] }, "build");
  await callHook(plugin.buildStart, context);
  return {
    warnings,
    logs,
    transform: (code, id) => callHook(plugin.transform, context, code, id),
    buildStart: async () => {
      await callHook(plugin.buildStart, context);
    },
    watchChange: async (id, event) => {
      await callHook(plugin.watchChange, context, id, { event });
    },
    close: async () => {
      await callHook(plugin.buildEnd, context);
      await callHook(plugin.closeBundle, context);
    },
  };
}

/** Transforms `code` as module `id` through `host` and returns the result with the warnings it reported. */
export async function transformCollecting(
  host: Host,
  code: string,
  id: string,
): Promise<Transformed> {
  const seen = host.logs.length;
  const result = await host.transform(code, id);
  return { result, logs: host.logs.slice(seen) };
}
