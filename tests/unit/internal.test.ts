import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

describe("ecstatic/internal", () => {
  it("is exported from the package manifest at the built internal entry", () => {
    const manifest: unknown = JSON.parse(
      readFileSync(new URL("../../package.json", import.meta.url), "utf-8"),
    );

    expect(manifest).toMatchObject({
      exports: {
        "./internal": { types: "./dist/internal.d.ts", default: "./dist/internal.js" },
      },
    });
  });
});
