import { describe, expect, it } from "vitest";

import {
  components,
  type FieldDefault,
  f32,
  f64,
  i8,
  i16,
  i32,
  isComponentDescriptor,
  isFieldDescriptor,
  ref,
  u8,
  u16,
  u32,
} from "../src/component.js";
import { asMutableDescriptor } from "./fixtures.js";

describe("component", () => {
  it("returns a descriptor table", () => {
    const { ComponentSpecPosition: Position } = components({
      ComponentSpecPosition: { x: 0, y: 0 },
    });
    expect(typeof Position).toBe("object");
    expect(asMutableDescriptor(Position).__ecstatic_name).toBe("ComponentSpecPosition");
  });

  it("returns distinct descriptors for different components", () => {
    const { ComponentSpecA: A } = components({ ComponentSpecA: { val: 0 } });
    const { ComponentSpecB: B } = components({ ComponentSpecB: { val: 0 } });
    const { ComponentSpecC: C } = components({ ComponentSpecC: { flag: false } });
    expect(A).not.toBe(B);
    expect(B).not.toBe(C);
    expect(A).not.toBe(C);
  });

  it("stores name, sorted fields, and defaults on the descriptor", () => {
    const { ComponentSpecSprite: Sprite } = components({
      ComponentSpecSprite: { image: "", frame: 0, flip: false },
    });
    expect(asMutableDescriptor(Sprite).__ecstatic_name).toBe("ComponentSpecSprite");
    expect(asMutableDescriptor(Sprite).__ecstatic_fields[0]).toBe("flip");
    expect(asMutableDescriptor(Sprite).__ecstatic_fields[1]).toBe("frame");
    expect(asMutableDescriptor(Sprite).__ecstatic_fields[2]).toBe("image");
    expect(asMutableDescriptor(Sprite).__ecstatic_defaults.image).toBe("");
    expect(asMutableDescriptor(Sprite).__ecstatic_defaults.frame).toBe(0);
    expect(asMutableDescriptor(Sprite).__ecstatic_defaults.flip).toBe(false);
  });

  it("tags are 0-field descriptor tables", () => {
    const { ComponentSpecStunned: Stunned } = components({ ComponentSpecStunned: {} });
    expect(asMutableDescriptor(Stunned).__ecstatic_name).toBe("ComponentSpecStunned");
    expect(asMutableDescriptor(Stunned).__ecstatic_fields.length).toBe(0);
  });

  it("errors on duplicate component names", () => {
    components({ ComponentSpecDuplicateName: { x: 0 } });

    expect(() => {
      components({ ComponentSpecDuplicateName: { y: 0 } });
    }).toThrow(/component name already registered/);
  });

  it("sorts fields by byte order (uppercase before lowercase)", () => {
    const { ComponentSpecByteOrder: ByteOrder } = components({
      ComponentSpecByteOrder: { Zap: 0, alpha: 0, Beta: 0 },
    });
    // ASCII: B=66, Z=90, a=97
    // Byte order: Beta(66) < Zap(90) < alpha(97)
    expect(asMutableDescriptor(ByteOrder).__ecstatic_fields[0]).toBe("Beta");
    expect(asMutableDescriptor(ByteOrder).__ecstatic_fields[1]).toBe("Zap");
    expect(asMutableDescriptor(ByteOrder).__ecstatic_fields[2]).toBe("alpha");
  });

  describe("field name validation", () => {
    it("rejects field names starting with a digit", () => {
      expect(() => {
        components({ ComponentSpecValidation_digit: { "1field": 0 } });
      }).toThrow();
    });

    it("rejects field names containing a hyphen", () => {
      expect(() => {
        components({ ComponentSpecValidation_hyphen: { "field-name": 0 } });
      }).toThrow();
    });

    it("rejects field names containing a space", () => {
      expect(() => {
        components({ ComponentSpecValidation_space: { "field name": 0 } });
      }).toThrow();
    });

    it("rejects field names with non-ASCII characters", () => {
      expect(() => {
        components({ ComponentSpecValidation_nonascii: { café: 0 } });
      }).toThrow();
    });

    it("accepts valid field names (letter/underscore start, alphanumeric and underscores)", () => {
      expect(() => {
        components({
          ComponentSpecValidation_letter: { field: 0 },
          ComponentSpecValidation_underscore: { _field: 0 },
          ComponentSpecValidation_mixed: { Field1_name: 0 },
          ComponentSpecValidation_uppercase: { Field: 0 },
        });
      }).not.toThrow();
    });
  });

  describe("ref", () => {
    it("returns the same sentinel object on every call", () => {
      const ref1 = ref();
      const ref2 = ref();
      expect(ref1).toBe(ref2);
    });

    it("errors on table default that is not ref()", () => {
      expect(() => {
        // @ts-expect-error table defaults are rejected at the type level too
        components({ ComponentSpecRefRejectTable: { tbl: { a: 1 } } });
      }).toThrow(/declare the field with ref/);
    });

    it("marks ref field in __ecstatic_is_reference", () => {
      const { ComponentSpecRefField: RefComp } = components({
        ComponentSpecRefField: { r: ref() },
      });
      expect(asMutableDescriptor(RefComp).__ecstatic_is_reference[0]).toBe(true);
    });

    it("stores undefined as default value for ref field", () => {
      const { ComponentSpecRefDefault: RefComp } = components({
        ComponentSpecRefDefault: { r: ref() },
      });
      expect(asMutableDescriptor(RefComp).__ecstatic_default_values[0]).toBeUndefined();
    });

    it("marks scalar field with is_reference false", () => {
      const { ComponentSpecScalarField: ScalarComp } = components({
        ComponentSpecScalarField: { x: 0 },
      });
      expect(asMutableDescriptor(ScalarComp).__ecstatic_is_reference[0]).toBe(false);
    });

    it("mixed ref and scalar fields have correct is_reference markers", () => {
      const { ComponentSpecMixed: MixedComp } = components({
        ComponentSpecMixed: { health: 100, target: ref(), cooldown: 0 },
      });
      // fields are sorted, so order is: cooldown, health, target
      expect(asMutableDescriptor(MixedComp).__ecstatic_is_reference[0]).toBe(false); // cooldown
      expect(asMutableDescriptor(MixedComp).__ecstatic_is_reference[1]).toBe(false); // health
      expect(asMutableDescriptor(MixedComp).__ecstatic_is_reference[2]).toBe(true); // target
    });
  });
});

describe("width markers", () => {
  it.each([
    { label: "f32", widthFn: f32, value: 1.5 },
    { label: "f64", widthFn: f64, value: 42 },
    { label: "i32", widthFn: i32, value: 100 },
    { label: "i16", widthFn: i16, value: 50 },
    { label: "i8", widthFn: i8, value: 10 },
    { label: "u32", widthFn: u32, value: 200 },
    { label: "u16", widthFn: u16, value: 60 },
    { label: "u8", widthFn: u8, value: 20 },
  ])("$label() wraps a numeric default", ({ label, widthFn, value }) => {
    const name = `Width${label.toUpperCase()}`;
    const { [name]: Comp } = components({
      [name]: { value: widthFn(value) },
    });
    expect(asMutableDescriptor(Comp).__ecstatic_defaults.value).toBe(value);
  });

  it.each([
    { label: "f32", widthFn: f32, value: 1.5, ctor: Float32Array },
    { label: "i32", widthFn: i32, value: 100, ctor: Int32Array },
    { label: "u8", widthFn: u8, value: 5, ctor: Uint8Array },
  ])("stores column constructor for $label", ({ label, widthFn, value, ctor }) => {
    const name = `Width${label.toUpperCase()}Ctor`;
    const { [name]: Comp } = components({
      [name]: { x: widthFn(value) },
    });
    expect(asMutableDescriptor(Comp).__ecstatic_column_ctor?.[0]).toBe(ctor);
  });
});

describe("isComponentDescriptor", () => {
  it("returns true for valid component descriptors", () => {
    const { DescValid: Comp } = components({ DescValid: { x: 0 } });
    expect(isComponentDescriptor(Comp)).toBe(true);
  });

  it.each([
    { label: "null", value: null },
    { label: "undefined", value: undefined },
    { label: "a string", value: "string" },
    { label: "a number", value: 42 },
    { label: "a boolean", value: true },
    { label: "an array", value: [1, 2, 3] },
    { label: "a plain object without descriptor properties", value: { x: 0, y: 0 } },
    {
      label: "an object with partial descriptor properties",
      value: { __ecstatic_name: "Partial" /* missing __ecstatic_fields */ },
    },
  ])("returns false for $label", ({ value }) => {
    expect(isComponentDescriptor(value)).toBe(false);
  });
});

describe("isFieldDescriptor", () => {
  it("returns true for field descriptors", () => {
    const { FieldDesc: Comp } = components({ FieldDesc: { x: 0 } });
    expect(isFieldDescriptor(Comp.x)).toBe(true);
  });

  it.each([
    { label: "null", value: null },
    { label: "undefined", value: undefined },
    { label: "a string", value: "string" },
    { label: "a number", value: 42 },
    { label: "an array", value: [1, 2] },
    { label: "an object without field descriptor properties", value: { x: 0 } },
  ])("returns false for $label", ({ value }) => {
    expect(isFieldDescriptor(value)).toBe(false);
  });

  it("returns false for component descriptors", () => {
    const { CompNotField: Comp } = components({ CompNotField: { x: 0 } });
    expect(isFieldDescriptor(Comp)).toBe(false);
  });
});

describe("special object types rejection", () => {
  it("rejects Date as component fields argument", () => {
    expect(() => {
      components({
        ComponentSpecValidation_date: new Date(),
      } as unknown as Record<string, Record<string, FieldDefault>>);
    }).toThrow(/component fields must be a table/);
  });

  it("rejects Map as component fields argument", () => {
    expect(() => {
      components({
        ComponentSpecValidation_map: new Map(),
      } as unknown as Record<string, Record<string, FieldDefault>>);
    }).toThrow(/component fields must be a table/);
  });

  it("rejects Set as component fields argument", () => {
    expect(() => {
      components({
        ComponentSpecValidation_set: new Set(),
      } as unknown as Record<string, Record<string, FieldDefault>>);
    }).toThrow(/component fields must be a table/);
  });
});
