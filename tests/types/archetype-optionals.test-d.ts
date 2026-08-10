import { describe, expectTypeOf, it } from "vitest";

import type { ArchetypeDescriptor } from "../../src/archetype.js";
import type { ComponentDescriptor } from "../../src/component.js";
import type { OptionalsOf } from "../../src/index.js";
import { archetype } from "../../src/index.js";
import { Position, Shield, Stunned } from "./_fixtures.js";

describe("archetype optionals typing", () => {
  it("captures the exact optionals tuple", () => {
    const arch = archetype([Position], [Shield, Stunned]);
    expectTypeOf<OptionalsOf<typeof arch>>().toEqualTypeOf<
      readonly [typeof Shield, typeof Stunned]
    >();
  });

  it("yields the empty tuple when no optionals are declared", () => {
    const arch = archetype([Position]);
    expectTypeOf<OptionalsOf<typeof arch>>().toEqualTypeOf<readonly []>();
  });

  it("falls back to the wide type for a bare ArchetypeDescriptor", () => {
    expectTypeOf<OptionalsOf<ArchetypeDescriptor>>().toEqualTypeOf<
      readonly ComponentDescriptor[]
    >();
  });

  it("keeps existing call sites compiling through the defaulted generic", () => {
    const arch = archetype([Position]);
    expectTypeOf(arch).toExtend<ArchetypeDescriptor>();
    expectTypeOf(arch.archetype).toExtend<ArchetypeDescriptor>();
  });
});
