/**
 * Command line of the allocation gate (`gate.ts`).
 *
 * Kept apart from `gate.ts`, which runs at load and imports the compiled
 * package, so the command line can be checked without building it.
 */

import { FAILURE_EXIT, isDefaultEngines, parseArgs, USAGE_EXIT, UsageError } from "../runner.js";

/** Usage line the gate prints on stderr for a command line it does not support. */
export const GATE_USAGE = "usage: gate.ts [--child <op>]";

/**
 * What the gate does for a command line: gate every op, measure one op in a
 * child, or refuse with a usage status and message for stderr.
 */
export type GateCommand =
  | { readonly mode: "parent" }
  | { readonly mode: "child"; readonly op: string }
  | { readonly mode: "usage"; readonly exitCode: typeof USAGE_EXIT; readonly message: string };

/**
 * Parse the gate's command line: nothing, or `--child <op>`.
 *
 * @param argv - Argument list after the executable and script, i.e. `process.argv.slice(2)`;
 * read only, never mutated.
 * @returns Parent mode for an empty command line; child mode naming the op for `--child <op>`;
 * usage mode carrying `USAGE_EXIT` and {@link GATE_USAGE} for a filter, `--optimized`, or any
 * engine list other than the default.
 * @throws UsageError propagated from `parseArgs` when the arguments do not fit the shared
 * parser's grammar.
 */
export function parseGateArgs(argv: readonly string[]): GateCommand {
  const args = parseArgs(argv);
  if (args.mode === "child") return { mode: "child", op: args.benchName };
  // The shared parser also accepts a filter, engines, and --optimized; the gate has none of them.
  if (args.filter !== undefined || !isDefaultEngines(args.engines) || args.optimized) {
    return { mode: "usage", exitCode: USAGE_EXIT, message: GATE_USAGE };
  }
  return { mode: "parent" };
}

/**
 * Exit status for an error that escapes the gate.
 *
 * @param error - The caught value.
 * @returns `USAGE_EXIT` for a `UsageError`, `FAILURE_EXIT` for anything else.
 */
export function gateExitStatus(error: unknown): number {
  return error instanceof UsageError ? USAGE_EXIT : FAILURE_EXIT;
}
