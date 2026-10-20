import { describe, expectTypeOf, it } from "vitest";

import ecstatic from "../../src/plugin/vite.js";

type ViteOptions = NonNullable<Parameters<typeof ecstatic>[0]>;

describe("ecstatic() for Vite", () => {
  it("takes only project and strict", () => {
    expectTypeOf<keyof ViteOptions>().toEqualTypeOf<"project" | "strict">();
  });

  it("takes a tsconfig path as project and a boolean as strict", () => {
    expectTypeOf<ViteOptions>().toEqualTypeOf<{
      readonly project?: string;
      readonly strict?: boolean;
    }>();
  });
});
