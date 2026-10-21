/** `CI` values that mean "not a CI runner", compared lowercased. */
const NOT_CI: ReadonlySet<string> = new Set(["", "false", "0"]);

/** Whether the real-Bun case must run: Bun is installed, or `ci` is set to anything but empty, `false`, or `0`. */
export function requiresRealBun(bunInstalled: boolean, ci: string | undefined): boolean {
  return bunInstalled || (ci !== undefined && !NOT_CI.has(ci.toLowerCase()));
}
