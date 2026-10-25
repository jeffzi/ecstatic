import { sep } from "node:path";

import { describe, expect, it } from "vitest";

import {
  compilerFileName,
  fileKey,
  nativeFileName,
} from "../../../src/plugin/optimizer/file-names.js";

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

describe("fileKey", () => {
  it.each([
    { separator: "\\", vite: "c:/work/app/main.ts", native: "C:\\work\\app\\main.ts" },
    { separator: "\\", vite: "C:/work/app/main.ts", native: "c:\\work\\app\\main.ts" },
  ])(
    "gives the Vite id $vite the key of the native path $native with the separator $separator",
    ({ separator, vite, native }) => {
      const key = fileKey(vite, separator);

      expect(key).toBe(fileKey(native, separator));
    },
  );

  it("keeps a backslash in a name as written with the separator /", () => {
    const key = fileKey("/app/a\\b.ts", "/");

    expect(key).toBe("/app/a\\b.ts");
  });

  it.each([
    { separator: "\\", first: "C:/work/app/main.ts", second: "D:/work/app/main.ts" },
    { separator: "\\", first: "C:/work/App/main.ts", second: "C:/work/app/main.ts" },
    { separator: "/", first: "/home/Me/app/main.ts", second: "/home/me/app/main.ts" },
    { separator: "/", first: "/app/a\\b.ts", second: "/app/a/b.ts" },
  ])(
    "gives $first and $second different keys with the separator $separator",
    ({ separator, first, second }) => {
      const key = fileKey(first, separator);

      expect(key).not.toBe(fileKey(second, separator));
    },
  );

  it("splits names at the platform's separator by default", () => {
    const name = "C:\\work\\App\\main.ts";

    const key = fileKey(name);

    expect(key).toBe(fileKey(name, sep));
  });
});
