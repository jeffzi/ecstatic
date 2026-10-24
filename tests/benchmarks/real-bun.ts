import { spawnSync } from "node:child_process";

/** `CI` values that mean "not a CI runner", compared lowercased. */
const NOT_CI: ReadonlySet<string> = new Set(["", "false", "0"]);

/** Whether the real-Bun case must run: Bun is installed, or `ci` is set to anything but empty, `false`, or `0`. */
export function requiresRealBun(bunInstalled: boolean, ci: string | undefined): boolean {
  return bunInstalled || (ci !== undefined && !NOT_CI.has(ci.toLowerCase()));
}

/** Whether this machine must run the real-Bun cases: `bun --version` succeeds, or the `CI` environment variable marks a CI runner. */
export function realBunRequired(): boolean {
  return requiresRealBun(spawnSync("bun", ["--version"]).status === 0, process.env["CI"]);
}
