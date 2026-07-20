import { describe, expectTypeOf, it } from "vitest";

import { type Component, component } from "../../src/index.js";

describe("component", () => {
  it("returns Component<N, T> with correct name and fields", () => {
    const Pos = component("CompDPosition", { x: 0, y: 0 });

    expectTypeOf(Pos).toEqualTypeOf<Component<"CompDPosition", { x: number; y: number }>>();
  });
});
