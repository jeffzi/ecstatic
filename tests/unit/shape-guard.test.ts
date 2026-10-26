import { assert, describe, expect, it } from "vitest";

import { type ArchetypeDescriptor, archetype } from "../../src/ecstatic/archetype.js";
import { type ComponentDescriptor, component, ref, u8 } from "../../src/ecstatic/component.js";
import { relation } from "../../src/ecstatic/relation.js";
import { assertFilterMember, assertShape } from "../../src/ecstatic/shape-guard.js";
import { createWorld, register, type Storage } from "../../src/ecstatic/world.js";
import { asMutableDescriptor } from "./fixtures.js";

const Position = component("Position", { x: 0, y: 0 });
const Shield = component("Shield", { hp: 0 });
const Stunned = component("Stunned");
const Boost = component("Boost");
const Body = component("Body", { z: false, a: "", m: 0 });
const Packed = component("Packed", { w: u8(0), o: ref() });
// @ts-expect-error array defaults sit outside FieldDefault but are accepted at runtime
const Mixed = component("Mixed", { b: 0, Z: false, _q: [0] });
const ChildOf = relation("ChildOf", { order: 0 });
const CommaName = component("A,B");
const A = component("A");
const B = component("B");
const Delta = component("Δ");
const Rocket = component("Rocket\u{1F680}");

/** Registers `arch` in a fresh world and returns its storage. */
function storageOf(arch: ArchetypeDescriptor): Storage {
  return register(createWorld(), arch);
}

/** Runs `act` and returns the error it throws, failing the test when it returns normally. */
function errorFrom(act: () => void): Error {
  try {
    act();
  } catch (error) {
    assert(error instanceof Error, "expected an Error instance");
    return error;
  }
  throw new Error("expected the call to throw");
}

describe("assertShape", () => {
  describe("when the key matches the storage's shape", () => {
    it.each([
      {
        name: "required then optional, each name length-prefixed",
        arch: archetype([Position], [Shield, Stunned, Boost]),
        key: "c8:Position{1:x=n,1:y=n}|c6:Shield{2:hp=n}c7:Stunned{}c5:Boost{}",
      },
      {
        name: "fields sorted by name with their column kinds",
        arch: archetype([Body]),
        key: "c4:Body{1:a=p,1:m=n,1:z=b}|",
      },
      {
        name: "width marker as a number and ref as plain",
        arch: archetype([Packed]),
        key: "c6:Packed{1:o=p,1:w=n}|",
      },
      {
        name: "mixed-case names in code-unit order and an array as plain",
        arch: archetype([Mixed]),
        key: "c5:Mixed{1:Z=b,2:_q=p,1:b=n}|",
      },
      {
        name: "relation flag with data fields and no target",
        arch: archetype([ChildOf]),
        key: "r7:ChildOf{5:order=n}|",
      },
      {
        name: "comma inside a name stays one component",
        arch: archetype([CommaName]),
        key: "c3:A,B{}|",
      },
      {
        name: "two components",
        arch: archetype([A, B]),
        key: "c1:A{}c1:B{}|",
      },
      {
        name: "optional-only shape",
        arch: archetype([], [A]),
        key: "|c1:A{}",
      },
      {
        name: "non-ASCII name length counts UTF-16 code units",
        arch: archetype([Delta]),
        key: "c1:Δ{}|",
      },
      {
        name: "astral-plane name length counts a surrogate pair as two",
        arch: archetype([Rocket]),
        key: "c8:Rocket\u{1F680}{}|",
      },
    ])("returns for $name", ({ arch, key }) => {
      const storage = storageOf(arch);

      expect(() => {
        assertShape(storage, key);
      }).not.toThrow();
    });
  });

  describe("when the key differs from the storage's shape", () => {
    it.each([
      {
        name: "a same-named component with other fields",
        arch: archetype([Body]),
        key: "c4:Body{1:a=p,1:m=n}|",
        actual: "c4:Body{1:a=p,1:m=n,1:z=b}|",
      },
      {
        name: "a same-named component with other field kinds",
        arch: archetype([Body]),
        key: "c4:Body{1:a=n,1:m=n,1:z=b}|",
        actual: "c4:Body{1:a=p,1:m=n,1:z=b}|",
      },
      {
        name: "a plain component against a relation of the same name",
        arch: archetype([ChildOf]),
        key: "c7:ChildOf{5:order=n}|",
        actual: "r7:ChildOf{5:order=n}|",
      },
      {
        name: "a component named with a comma against two components",
        arch: archetype([CommaName]),
        key: "c1:A{}c1:B{}|",
        actual: "c3:A,B{}|",
      },
      {
        name: "a required component against an optional one",
        arch: archetype([], [A]),
        key: "c1:A{}|",
        actual: "|c1:A{}",
      },
    ])("throws naming both shapes for $name", ({ arch, key, actual }) => {
      const storage = storageOf(arch);

      const error = errorFrom(() => {
        assertShape(storage, key);
      });

      expect(error.message).toBe(`ecstatic: shape guard expected ${key}, got ${actual}`);
    });

    it("throws on a repeated call to a storage that matched before", () => {
      const storage = storageOf(archetype([Position]));
      assertShape(storage, "c8:Position{1:x=n,1:y=n}|");

      const error = errorFrom(() => {
        assertShape(storage, "c8:Position{1:x=n}|");
      });

      expect(error.message).toBe(
        "ecstatic: shape guard expected c8:Position{1:x=n}|, got c8:Position{1:x=n,1:y=n}|",
      );
    });
  });

  describe("when another storage matched the key before", () => {
    it("throws naming the differing storage's shape", () => {
      const key = "c8:Position{1:x=n,1:y=n}|";
      assertShape(storageOf(archetype([Position])), key);
      const other = storageOf(archetype([Shield]));

      const error = errorFrom(() => {
        assertShape(other, key);
      });

      expect(error.message).toBe(`ecstatic: shape guard expected ${key}, got c6:Shield{2:hp=n}|`);
    });
  });

  describe("when the caller mutates the arrays its archetype was built from", () => {
    it("returns for the key of the registered shape", () => {
      const Hatch = component("Hatch", { open: false });
      const required: ComponentDescriptor[] = [Hatch];
      const storage = storageOf(archetype(required));

      required.push(Shield);

      expect(() => {
        assertShape(storage, "c5:Hatch{4:open=b}|");
      }).not.toThrow();
    });
  });

  describe("when the key matches a storage that failed before", () => {
    it("returns", () => {
      const storage = storageOf(archetype([Shield]));
      errorFrom(() => {
        assertShape(storage, "c6:Shield{}|");
      });

      expect(() => {
        assertShape(storage, "c6:Shield{2:hp=n}|");
      }).not.toThrow();
    });
  });

  describe("when the value has no archetype", () => {
    it.each([
      { name: "an array", value: [] },
      { name: "a number", value: 42 },
      { name: "null", value: null },
      { name: "undefined", value: undefined },
      { name: "an object whose archetype is no archetype", value: { archetype: 1 } },
    ])("throws naming the expected shape and the missing archetype for $name", ({ value }) => {
      const error = errorFrom(() => {
        assertShape(value, "c1:A{}|");
      });

      expect(error.message).toBe(
        "ecstatic: shape guard expected c1:A{}|, got a value with no archetype",
      );
    });
  });
});

describe("assertFilterMember", () => {
  describe("when the archetype agrees with the build", () => {
    it.each([
      { name: "a held component expected present", expectPresent: true, descriptor: Shield },
      { name: "a missing component expected absent", expectPresent: false, descriptor: Boost },
    ])("returns for $name", ({ expectPresent, descriptor }) => {
      const storage = storageOf(archetype([Position, Shield]));

      expect(() => {
        assertFilterMember(storage, descriptor, expectPresent);
      }).not.toThrow();
    });
  });

  describe("when the archetype disagrees with the build", () => {
    it.each([
      {
        name: "a missing component expected present",
        expectPresent: true,
        descriptor: Boost,
        componentName: "Boost",
        expected: "present",
        other: "absent",
      },
      {
        name: "a held component expected absent",
        expectPresent: false,
        descriptor: Shield,
        componentName: "Shield",
        expected: "absent",
        other: "present",
      },
    ])(
      "throws naming the component and the expectation for $name",
      ({ expectPresent, descriptor, componentName, expected, other }) => {
        const storage = storageOf(archetype([Position, Shield]));

        const error = errorFrom(() => {
          assertFilterMember(storage, descriptor, expectPresent);
        });

        expect(error.message).toContain(componentName);
        expect(error.message).toContain(expected);
        expect(error.message).not.toContain(other);
      },
    );
  });

  describe("when the archetype holds a different descriptor of the same name", () => {
    it("throws for the descriptor expected present", () => {
      const storage = storageOf(archetype([Shield]));
      const OtherShield = component("ShieldTwin", { hp: 0 });
      asMutableDescriptor(OtherShield).__ecstatic_name = "Shield";

      const error = errorFrom(() => {
        assertFilterMember(storage, OtherShield, true);
      });

      expect(error.message).toContain("Shield");
    });
  });

  describe("when the value has no archetype", () => {
    it.each([
      { name: "null", value: null, expectPresent: true },
      { name: "undefined", value: undefined, expectPresent: false },
      { name: "an object without archetype metadata", value: {}, expectPresent: false },
      {
        name: "an object whose archetype is no archetype",
        value: { archetype: 1 },
        expectPresent: true,
      },
    ])(
      "throws naming the component and the missing archetype for $name",
      ({ value, expectPresent }) => {
        const error = errorFrom(() => {
          assertFilterMember(value, Shield, expectPresent);
        });

        expect(error.message).toContain("Shield");
        expect(error.message).toContain("no archetype");
      },
    );
  });
});
