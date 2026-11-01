/**
 * Command line of the allocation gate (`gate.ts`).
 *
 * Kept apart from `gate.ts`, which runs at load and imports the compiled
 * package, so the command line can be checked without building it.
 */

import { errorMessage } from "../../scripts/caught.js";
import { exitCodeFor, isDefaultEngines, parseArgs, USAGE_EXIT } from "../runner.js";

/** Usage line the gate prints on stderr for a command line it does not support. */
export const GATE_USAGE = "usage: gate.ts [--child <op>]";

/**
 * What the gate does for a command line: gate every op, measure one op in a
 * child, or refuse it as unsupported.
 */
export type GateCommand =
  | { readonly mode: "parent" }
  | { readonly mode: "child"; readonly op: string }
  | { readonly mode: "usage" };

/**
 * Parse the gate's command line: nothing, or `--child <op>`.
 *
 * @param argv - Argument list after the executable and script, i.e. `process.argv.slice(2)`;
 * read only, never mutated.
 * @returns Parent mode for an empty command line; child mode naming the op for `--child <op>`;
 * usage mode for a filter, `--optimized`, or any engine list other than the default.
 * @throws UsageError propagated from `parseArgs` when the arguments do not fit the shared
 * parser's grammar.
 */
export function parseGateArgs(argv: readonly string[]): GateCommand {
  const args = parseArgs(argv);
  if (args.mode === "child") return { mode: "child", op: args.benchName };
  // The shared parser also accepts a filter, engines, and --optimized; the gate has none of them.
  if (args.filter !== undefined || !isDefaultEngines(args.engines) || args.optimized) {
    return { mode: "usage" };
  }
  return { mode: "parent" };
}

/**
 * Injected side of `runGate`: each run returns a process exit code, and `reportError` receives one
 * message line (stderr in the gate).
 */
export interface GateRuns {
  readonly parent: () => number;
  readonly child: (op: string) => number;
  readonly reportError: (line: string) => void;
}

/**
 * Run the gate for a command line: the parent run, one op's child run, or a refusal.
 *
 * A refused command line prints {@link GATE_USAGE}, or the shared parser's message, and runs
 * nothing. An error a run throws is printed too; it never escapes.
 *
 * @param argv - Argument list after the executable and script, i.e. `process.argv.slice(2)`.
 * @param runs - The parent and child runs, and the sink for error lines (stderr in the gate).
 * @returns The run's exit code; `USAGE_EXIT` for a refused command line or a `UsageError`;
 * `FAILURE_EXIT` for any other error.
 */
export function runGate(argv: readonly string[], runs: GateRuns): number {
  try {
    const command = parseGateArgs(argv);
    switch (command.mode) {
      case "child":
        return runs.child(command.op);
      case "usage":
        runs.reportError(GATE_USAGE);
        return USAGE_EXIT;
      case "parent":
        return runs.parent();
      default:
        return assertNever(command);
    }
  } catch (error) {
    runs.reportError(errorMessage(error));
    return exitCodeFor(error);
  }
}

function assertNever(command: never): never {
  throw new Error(`unhandled gate command: ${JSON.stringify(command)}`);
}
