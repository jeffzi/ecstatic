/**
 * The ttsc plugin descriptor, imported by ttsc as `ecstatic/optimizer` from a tsconfig's
 * `compilerOptions.plugins`.
 *
 * Its types are declared here rather than imported from `ttsc`, so the built declaration never
 * makes a consumer without the optional `ttsc` peer resolve it.
 */

// oxlint-disable-next-line import/no-nodejs-modules -- ttsc loads the descriptor under Node; it is never bundled into the runtime
import { resolve } from "node:path";

/** What ttsc hands the descriptor factory; only `dirname` is read. */
export interface TtscPluginContext {
  /** Directory of the loaded descriptor module. */
  readonly dirname: string;
}

/** The descriptor ttsc reads to build and run the optimizer. */
export interface EcstaticTtscPlugin {
  readonly name: "ecstatic";
  /** Absolute path of the Go module root, whose `package main` ttsc builds the optimizer from. */
  readonly source: string;
  /** Empty: the factory reads no files, so ttsc may reuse its evaluation across launches. */
  readonly hostInputHashes: Readonly<Record<string, string | null>>;
}

/**
 * Build the descriptor for the optimizer's Go sources.
 *
 * The descriptor sits in `src/plugin/` in the repository and in `dist/plugin/` when published;
 * both are two levels below the package root, so one relative hop reaches `optimizer/`, the Go
 * module whose root package is the command.
 *
 * @param context - The load context ttsc passes to a descriptor factory.
 * @returns The descriptor naming the optimizer's Go module root.
 */
export default function createTtscPlugin(context: TtscPluginContext): EcstaticTtscPlugin {
  return {
    name: "ecstatic",
    source: resolve(context.dirname, "..", "..", "optimizer"),
    hostInputHashes: {},
  };
}
