import { describe, expect, it } from "vitest";

import { VERSION } from "../src/index.js";
import { readPackageVersion } from "../src/version.js";

describe("readPackageVersion", () => {
  it("returns the version string from a package manifest", () => {
    expect(readPackageVersion({ version: "1.2.3" })).toBe("1.2.3");
  });

  it.each([
    { label: "null", value: null },
    { label: "a non-object", value: "1.2.3" },
    { label: "an object without a version field", value: {} },
    { label: "a non-string version", value: { version: 123 } },
  ])("throws for $label", ({ value }) => {
    expect(() => readPackageVersion(value)).toThrow("missing a string version field");
  });
});

describe("VERSION", () => {
  it("is a semver string", () => {
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });
});
