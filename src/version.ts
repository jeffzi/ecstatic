/**
 * Extract the `version` field from a parsed package.json manifest.
 *
 * The manifest arrives as `unknown` because it is loaded from disk at
 * runtime; this narrows it instead of asserting.
 *
 * @throws Error when the value is not an object with a string `version`.
 */
export function readPackageVersion(manifest: unknown): string {
  if (
    typeof manifest === "object" &&
    manifest !== null &&
    "version" in manifest &&
    typeof manifest.version === "string"
  ) {
    return manifest.version;
  }
  throw new Error("package.json is missing a string version field");
}
