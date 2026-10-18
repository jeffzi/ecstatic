import { describe, expectTypeOf, it } from "vitest";

import ecstatic from "../../src/plugin/vite.js";

type ViteOptions = NonNullable<Parameters<typeof ecstatic>[0]>;

describe("ecstatic() for Vite", () => {
  it("takes only project, projectRoot, and precompile, so the tsconfig's plugin list runs", () => {
    expectTypeOf<keyof ViteOptions>().toEqualTypeOf<"project" | "projectRoot" | "precompile">();
  });
});
