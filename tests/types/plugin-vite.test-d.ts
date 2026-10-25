import { describe, expectTypeOf, it } from "vitest";

import { OPTION_KEYS } from "../../src/plugin/options.js";
import ecstatic, { type EcstaticOptions } from "../../src/plugin/vite.js";

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

  it("accepts exactly the keys EcstaticOptions declares", () => {
    expectTypeOf<keyof typeof OPTION_KEYS>().toEqualTypeOf<keyof EcstaticOptions>();
  });

  it("exports the plugin factory as its only value", () => {
    expectTypeOf<keyof typeof import("../../src/plugin/vite.js")>().toEqualTypeOf<"default">();
  });
});
