import { describe, expect, it } from "vitest";

import { compilerFileName, nativeFileName } from "../../../src/plugin/optimizer/file-names.js";

describe("nativeFileName", () => {
  it.each([
    {
      platform: "Windows",
      separator: "\\",
      compiler: "C:/app/uses.ts",
      native: "C:\\app\\uses.ts",
    },
    { platform: "POSIX", separator: "/", compiler: "/app/uses.ts", native: "/app/uses.ts" },
  ])("spells a compiler file name with the separator of $platform", (row) => {
    expect(nativeFileName(row.compiler, row.separator)).toBe(row.native);
  });
});

describe("compilerFileName", () => {
  it.each([
    {
      platform: "Windows",
      separator: "\\",
      native: "C:\\app\\uses.ts",
      compiler: "C:/app/uses.ts",
    },
    { platform: "POSIX", separator: "/", native: "/app/a\\b.ts", compiler: "/app/a\\b.ts" },
  ])("spells a file name of $platform with `/` separators", (row) => {
    expect(compilerFileName(row.native, row.separator)).toBe(row.compiler);
  });
});
