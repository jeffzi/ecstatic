import { assert, describe, expect, it } from "vitest";

import { Archetype, archetype } from "../../src/ecstatic/archetype.js";
import { type ComponentDescriptor, component, components } from "../../src/ecstatic/component.js";
import { asMutableDescriptor } from "./fixtures.js";

describe("archetype", () => {
  describe("basic construction", () => {
    it("creates an archetype descriptor from required components", () => {
      const { ArchTestReq_A: A } = components({ ArchTestReq_A: { x: 0 } });
      const { ArchTestReq_B: B } = components({ ArchTestReq_B: { y: 0 } });

      const arch = archetype([A, B]);
      expect(arch).toStrictEqual(
        expect.objectContaining({
          components: [A, B],
          optionals: [],
          // oxlint-disable-next-line typescript/no-unsafe-assignment -- expect.any() returns any by design
          id: expect.any(Number),
        }),
      );
    });

    it("creates an archetype descriptor with required and optional components", () => {
      const { ArchTestOpt_Req: Req } = components({
        ArchTestOpt_Req: { x: 0 },
      });
      const { ArchTestOpt_Opt: Opt } = components({
        ArchTestOpt_Opt: { flag: false },
      });

      const arch = archetype([Req], [Opt]);
      expect(arch).toStrictEqual(
        expect.objectContaining({
          components: [Req],
          optionals: [Opt],
        }),
      );
    });

    it("returns the same descriptor object for the same component lists", () => {
      const { ArchTestCanon_A: A } = components({
        ArchTestCanon_A: { x: 0 },
      });
      const { ArchTestCanon_B: B } = components({
        ArchTestCanon_B: { y: 0 },
      });

      const arch1 = archetype([A, B]);
      const arch2 = archetype([A, B]);
      expect(arch1).toBe(arch2);
    });

    it("creates distinct descriptors for different component lists", () => {
      const { ArchTestDist_A: A } = components({
        ArchTestDist_A: { x: 0 },
      });
      const { ArchTestDist_B: B } = components({
        ArchTestDist_B: { y: 0 },
      });
      const { ArchTestDist_C: C } = components({
        ArchTestDist_C: { z: 0 },
      });

      const arch1 = archetype([A, B]);
      const arch2 = archetype([A, C]);
      expect(arch1).not.toBe(arch2);
    });
  });

  describe("component lookup", () => {
    it("provides componentByName Map for required components", () => {
      const { ArchTestLookup_A: A } = components({
        ArchTestLookup_A: { x: 0 },
      });

      const arch = archetype([A]);
      expect(arch.componentByName.get("ArchTestLookup_A")).toBe(A);
    });

    it("provides componentByName Map for optional components", () => {
      const { ArchTestLookupOpt_A: A } = components({
        ArchTestLookupOpt_A: { x: 0 },
      });
      const { ArchTestLookupOpt_B: B } = components({
        ArchTestLookupOpt_B: { flag: false },
      });

      const arch = archetype([A], [B]);
      expect(arch.componentByName.get("ArchTestLookupOpt_B")).toBe(B);
    });

    it("provides componentLookup holding the required and the optional components", () => {
      const { ArchTestMember_A: A, ArchTestMember_B: B } = components({
        ArchTestMember_A: { x: 0 },
        ArchTestMember_B: { y: 0 },
      });

      const arch = archetype([A], [B]);

      expect(arch.componentLookup).toStrictEqual(new Set([A, B]));
    });
  });

  describe("optional bits", () => {
    it("assigns bits 1, 2, 4, ... in declaration order", () => {
      const { ArchTestBits_A: A } = components({
        ArchTestBits_A: { x: 0 },
      });
      const { ArchTestBits_B: B } = components({
        ArchTestBits_B: { y: 0 },
      });
      const { ArchTestBits_C: C } = components({
        ArchTestBits_C: { z: 0 },
      });

      const arch = archetype([A], [B, C]);
      expect(arch.optionalBits.get("ArchTestBits_B")).toBe(1);
      expect(arch.optionalBits.get("ArchTestBits_C")).toBe(2);
    });

    it("provides optionalNotBits with bitwise complement", () => {
      const { ArchTestNotBits_A: A } = components({
        ArchTestNotBits_A: { x: 0 },
      });
      const { ArchTestNotBits_B: B } = components({
        ArchTestNotBits_B: { y: 0 },
      });

      const arch = archetype([A], [B]);
      const bit = arch.optionalBits.get("ArchTestNotBits_B");
      const notBit = arch.optionalNotBits.get("ArchTestNotBits_B");
      assert(bit != null);
      expect(notBit).toBe(~bit >>> 0);
    });

    it("provides optionalBitLookup keyed by descriptor", () => {
      const { ArchTestLookupBit_A: A } = components({
        ArchTestLookupBit_A: { x: 0 },
      });
      const { ArchTestLookupBit_B: B } = components({
        ArchTestLookupBit_B: { y: 0 },
      });

      const arch = archetype([A], [B]);
      expect(arch.optionalBitLookup.get(B)).toBe(1);
    });
  });

  describe("reserved names check", () => {
    it("rejects required component with reserved name 'entities'", () => {
      const { ReservedEntities: Comp } = components({
        ReservedEntities: { x: 0 },
      });
      asMutableDescriptor(Comp).__ecstatic_name = "entities";

      expect(() => {
        archetype([Comp]);
      }).toThrow(/component name entities is reserved on archetypes/);
    });

    it("rejects optional component with reserved name 'sparse'", () => {
      const { ReservedSparse: Comp } = components({
        ReservedSparse: { x: 0 },
      });
      asMutableDescriptor(Comp).__ecstatic_name = "sparse";

      const { ReservedReq: Req } = components({ ReservedReq: { y: 0 } });
      expect(() => {
        archetype([Req], [Comp]);
      }).toThrow(/component name sparse is reserved on archetypes/);
    });

    /** Declares a required component renamed to `name` and asserts `archetype` rejects it. */
    function expectReservedNameRejected(name: string): void {
      const { [`Reserved_${name}`]: Comp } = components({
        [`Reserved_${name}`]: { x: 0 },
      });
      assert(Comp != null);
      asMutableDescriptor(Comp).__ecstatic_name = name;

      expect(() => {
        archetype([Comp]);
      }).toThrow(`component name ${name} is reserved on archetypes`);
    }

    it.each([
      { group: "storage", name: "n" },
      { group: "storage", name: "mask" },
      { group: "storage", name: "columns" },
      { group: "storage", name: "flatColumns" },
      { group: "storage", name: "fieldColumns" },
      { group: "storage", name: "world" },
      { group: "descriptor", name: "id" },
      { group: "descriptor", name: "components" },
      { group: "descriptor", name: "optionals" },
      { group: "descriptor", name: "componentByName" },
      { group: "descriptor", name: "componentLookup" },
      { group: "descriptor", name: "optionalBits" },
      { group: "descriptor", name: "optionalNotBits" },
      { group: "descriptor", name: "optionalBitLookup" },
      { group: "descriptor", name: "optionalNotBitLookup" },
      { group: "runtime", name: "generation" },
      { group: "runtime", name: "despawnClear" },
      { group: "matcher/optional", name: "matchers" },
      { group: "matcher/optional", name: "matcherMatched" },
      { group: "matcher/optional", name: "hasOptionalData" },
      { group: "matcher/optional", name: "hasDespawnClear" },
      { group: "relation", name: "relationTargetColumns" },
      { group: "relation", name: "relationDescriptors" },
      { group: "relation", name: "relationOptionalBits" },
      { group: "relation", name: "relationN" },
      { group: "relation", name: "hasRelations" },
    ])("rejects $group bookkeeping name '$name'", ({ name }) => {
      expectReservedNameRejected(name);
    });

    const declarationForms = [
      { form: "archetype([C])", key: "Req", declare: (c: ComponentDescriptor) => archetype([c]) },
      {
        form: "archetype([], [C])",
        key: "Opt",
        declare: (c: ComponentDescriptor) => archetype([], [c]),
      },
      {
        form: "class extends Archetype([C])",
        key: "Class",
        declare: (c: ComponentDescriptor) => class extends Archetype([c]) {},
      },
      {
        form: "class extends Archetype([], [C])",
        key: "ClassOpt",
        declare: (c: ComponentDescriptor) => class extends Archetype([], [c]) {},
      },
    ];

    it.each(
      Object.getOwnPropertyNames(Object.prototype).flatMap((name) =>
        declarationForms.map(({ form, key, declare }) => ({ name, form, key, declare })),
      ),
    )("rejects the Object.prototype name $name in $form", ({ name, key, declare }) => {
      const Comp = component(`ReservedProto_${key}_${name}`, { x: 0 });
      asMutableDescriptor(Comp).__ecstatic_name = name;

      expect(() => declare(Comp)).toThrow(`component name ${name} is reserved on archetypes`);
    });

    it("rejects reserved name 'archetype'", () => {
      const { ReservedArch: Comp } = components({
        ReservedArch: { x: 0 },
      });
      asMutableDescriptor(Comp).__ecstatic_name = "archetype";

      expect(() => {
        archetype([Comp]);
      }).toThrow(/component name archetype is reserved on archetypes/);
    });
  });

  describe("duplicate component detection", () => {
    const listPositions = [
      {
        position: "twice in the required list",
        key: "Req",
        declare: (a: ComponentDescriptor, b: ComponentDescriptor) => archetype([a, b]),
      },
      {
        position: "twice in the optional list",
        key: "Opt",
        declare: (a: ComponentDescriptor, b: ComponentDescriptor) => archetype([], [a, b]),
      },
      {
        position: "in both the required and optional lists",
        key: "Both",
        declare: (a: ComponentDescriptor, b: ComponentDescriptor) => archetype([a], [b]),
      },
    ];

    it.each(listPositions)("rejects the same descriptor listed $position", ({ key, declare }) => {
      const name = `ArchTestDupSame_${key}`;
      const A = component(name, { x: 0 });

      expect(() => declare(A, A)).toThrow(`duplicate component ${name} in archetype`);
    });

    it.each([
      ...listPositions,
      {
        position: "twice in the class form",
        key: "Class",
        declare: (a: ComponentDescriptor, b: ComponentDescriptor) =>
          class extends Archetype([a, b]) {},
      },
    ])("rejects two distinct descriptors sharing a name $position", ({ key, declare }) => {
      const name = `ArchTestDupName_${key}`;
      const first = component(name, { x: 0 });
      const second = component(`${name}_Twin`, { x: 0 });
      asMutableDescriptor(second).__ecstatic_name = name;

      expect(() => declare(first, second)).toThrow(`duplicate component ${name} in archetype`);
    });
  });

  describe("optional bit limit", () => {
    it("errors when more than 32 optional components", () => {
      const { ArchTestMax_Req: Req } = components({
        ArchTestMax_Req: { x: 0 },
      });

      const optionals: ComponentDescriptor[] = [];
      for (let i = 0; i < 33; i++) {
        const { [i]: Comp } = components({
          [i]: { val: i },
        });
        assert(Comp != null);
        optionals.push(Comp);
      }

      expect(() => {
        archetype([Req], optionals);
      }).toThrow(/archetype supports at most 32 optional components/);
    });
  });

  describe("self-reference", () => {
    it("provides archetype.archetype === archetype self-reference", () => {
      const { ArchTestSelfRef: A } = components({
        ArchTestSelfRef: { x: 0 },
      });

      const arch = archetype([A]);
      expect(arch.archetype).toBe(arch);
    });
  });

  describe("descriptor immutability", () => {
    it("has an id property", () => {
      const { ArchTestID_A: A } = components({
        ArchTestID_A: { x: 0 },
      });

      const arch = archetype([A]);
      expect(typeof arch.id).toBe("number");
    });

    it("increments id across distinct archetypes", () => {
      const { ArchTestInc_A: A } = components({
        ArchTestInc_A: { x: 0 },
      });
      const { ArchTestInc_B: B } = components({
        ArchTestInc_B: { y: 0 },
      });

      const arch1 = archetype([A]);
      const arch2 = archetype([B]);
      expect(arch2.id).toBe(arch1.id + 1);
    });

    it("keeps its component lists when the caller mutates the arrays it passed", () => {
      const {
        ArchTestOwn_Req: Req,
        ArchTestOwn_Opt: Opt,
        ArchTestOwn_Late: Late,
      } = components({ ArchTestOwn_Req: { x: 0 }, ArchTestOwn_Opt: {}, ArchTestOwn_Late: {} });
      const required: ComponentDescriptor[] = [Req];
      const optionals: ComponentDescriptor[] = [Opt];
      const arch = archetype(required, optionals);

      required.push(Late);
      optionals.push(Late);

      expect(arch.components).toStrictEqual([Req]);
      expect(arch.optionals).toStrictEqual([Opt]);
    });
  });
});
