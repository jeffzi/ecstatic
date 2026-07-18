import { describe, expect, it } from "vitest";
import { archetype } from "../src/archetype";
import { components } from "../src/component";

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

    it("provides componentLookup for membership testing", () => {
      const { ArchTestMember_A: A } = components({
        ArchTestMember_A: { x: 0 },
      });

      const arch = archetype([A]);
      const lookupSet = arch.componentLookup as Set<typeof A>;
      expect(lookupSet.has(A)).toBe(true);
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
      expect(notBit).toBe(~bit! >>> 0);
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
      // Rename the descriptor to have reserved name
      (Comp as Record<string, unknown>).__ecstatic_name = "entities";

      expect(() => {
        archetype([Comp]);
      }).toThrow(/component name entities is reserved on archetypes/);
    });

    it("rejects optional component with reserved name 'sparse'", () => {
      const { ReservedSparse: Comp } = components({
        ReservedSparse: { x: 0 },
      });
      (Comp as Record<string, unknown>).__ecstatic_name = "sparse";

      const { ReservedReq: Req } = components({ ReservedReq: { y: 0 } });
      expect(() => {
        archetype([Req], [Comp]);
      }).toThrow(/component name sparse is reserved on archetypes/);
    });

    it("rejects reserved name 'archetype'", () => {
      const { ReservedArch: Comp } = components({
        ReservedArch: { x: 0 },
      });
      (Comp as Record<string, unknown>).__ecstatic_name = "archetype";

      expect(() => {
        archetype([Comp]);
      }).toThrow(/component name archetype is reserved on archetypes/);
    });
  });

  describe("duplicate component detection", () => {
    it("errors when same component appears in both required and optional", () => {
      const { ArchTestDupBoth: A } = components({
        ArchTestDupBoth: { x: 0 },
      });

      expect(() => {
        archetype([A], [A]);
      }).toThrow(/duplicate component/);
    });

    it("errors when same component appears twice in required list", () => {
      const { ArchTestDupReq: A } = components({
        ArchTestDupReq: { x: 0 },
      });

      expect(() => {
        archetype([A, A]);
      }).toThrow(/duplicate component/);
    });

    it("errors when same component appears twice in optional list", () => {
      const { ArchTestDupOpt: A } = components({
        ArchTestDupOpt: { x: 0 },
      });
      const { ArchTestDupOptReq: Req } = components({
        ArchTestDupOptReq: { y: 0 },
      });

      expect(() => {
        archetype([Req], [A, A]);
      }).toThrow(/duplicate component/);
    });
  });

  describe("optional bit limit", () => {
    it("errors when more than 32 optional components", () => {
      const { ArchTestMax_Req: Req } = components({
        ArchTestMax_Req: { x: 0 },
      });

      const optionals = [];
      for (let i = 0; i < 33; i++) {
        const { [i]: Comp } = components({
          [i]: { val: i },
        });
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
  });
});
