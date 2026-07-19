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
import { md } from "./fixtures.js";

describe("component", () => {
  it("returns a descriptor table", () => {
    const { ComponentSpecPosition: Position } = components({
      ComponentSpecPosition: { x: 0, y: 0 },
    });
    expect(typeof Position).toBe("object");
    expect(md(Position).__ecstatic_name).toBe("ComponentSpecPosition");
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
    expect(md(Sprite).__ecstatic_name).toBe("ComponentSpecSprite");
    expect(md(Sprite).__ecstatic_fields[0]).toBe("flip");
    expect(md(Sprite).__ecstatic_fields[1]).toBe("frame");
    expect(md(Sprite).__ecstatic_fields[2]).toBe("image");
    expect(md(Sprite).__ecstatic_defaults.image).toBe("");
    expect(md(Sprite).__ecstatic_defaults.frame).toBe(0);
    expect(md(Sprite).__ecstatic_defaults.flip).toBe(false);
  });

  it("tags are 0-field descriptor tables", () => {
    const { ComponentSpecStunned: Stunned } = components({ ComponentSpecStunned: {} });
    expect(md(Stunned).__ecstatic_name).toBe("ComponentSpecStunned");
    expect(md(Stunned).__ecstatic_fields.length).toBe(0);
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
    expect(md(ByteOrder).__ecstatic_fields[0]).toBe("Beta");
    expect(md(ByteOrder).__ecstatic_fields[1]).toBe("Zap");
    expect(md(ByteOrder).__ecstatic_fields[2]).toBe("alpha");
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
      expect(md(RefComp).__ecstatic_is_reference[0]).toBe(true);
    });

    it("stores undefined as default value for ref field", () => {
      const { ComponentSpecRefDefault: RefComp } = components({
        ComponentSpecRefDefault: { r: ref() },
      });
      expect(md(RefComp).__ecstatic_default_values[0]).toBeUndefined();
    });

    it("marks scalar field with is_reference false", () => {
      const { ComponentSpecScalarField: ScalarComp } = components({
        ComponentSpecScalarField: { x: 0 },
      });
      expect(md(ScalarComp).__ecstatic_is_reference[0]).toBe(false);
    });

    it("mixed ref and scalar fields have correct is_reference markers", () => {
      const { ComponentSpecMixed: MixedComp } = components({
        ComponentSpecMixed: { health: 100, target: ref(), cooldown: 0 },
      });
      // fields are sorted, so order is: cooldown, health, target
      expect(md(MixedComp).__ecstatic_is_reference[0]).toBe(false); // cooldown
      expect(md(MixedComp).__ecstatic_is_reference[1]).toBe(false); // health
      expect(md(MixedComp).__ecstatic_is_reference[2]).toBe(true); // target
    });

    it("error message for table default mentions ref", () => {
      expect(() => {
        // @ts-expect-error table defaults are rejected at the type level too
        components({ ComponentSpecRefErrorMsg: { tbl: { x: 1 } } });
      }).toThrow(/declare the field with ref/);
    });
  });
});

describe("width markers", () => {
  it("f32() wraps a numeric default", () => {
    const { WidthF32: Comp } = components({
      WidthF32: { speed: f32(1.5) },
    });
    expect(md(Comp).__ecstatic_defaults.speed).toBe(1.5);
  });

  it("f64() wraps a numeric default", () => {
    const { WidthF64: Comp } = components({
      WidthF64: { value: f64(42) },
    });
    expect(md(Comp).__ecstatic_defaults.value).toBe(42);
  });

  it("i32() wraps a numeric default", () => {
    const { WidthI32: Comp } = components({
      WidthI32: { count: i32(100) },
    });
    expect(md(Comp).__ecstatic_defaults.count).toBe(100);
  });

  it("i16() wraps a numeric default", () => {
    const { WidthI16: Comp } = components({
      WidthI16: { value: i16(50) },
    });
    expect(md(Comp).__ecstatic_defaults.value).toBe(50);
  });

  it("i8() wraps a numeric default", () => {
    const { WidthI8: Comp } = components({
      WidthI8: { value: i8(10) },
    });
    expect(md(Comp).__ecstatic_defaults.value).toBe(10);
  });

  it("u32() wraps a numeric default", () => {
    const { WidthU32: Comp } = components({
      WidthU32: { value: u32(200) },
    });
    expect(md(Comp).__ecstatic_defaults.value).toBe(200);
  });

  it("u16() wraps a numeric default", () => {
    const { WidthU16: Comp } = components({
      WidthU16: { value: u16(60) },
    });
    expect(md(Comp).__ecstatic_defaults.value).toBe(60);
  });

  it("u8() wraps a numeric default", () => {
    const { WidthU8: Comp } = components({
      WidthU8: { value: u8(20) },
    });
    expect(md(Comp).__ecstatic_defaults.value).toBe(20);
  });

  it("stores column constructor for f32", () => {
    const { WidthF32Ctor: Comp } = components({
      WidthF32Ctor: { x: f32(1.5) },
    });
    expect(md(Comp).__ecstatic_column_ctor?.[0]).toBe(Float32Array);
  });

  it("stores column constructor for i32", () => {
    const { WidthI32Ctor: Comp } = components({
      WidthI32Ctor: { x: i32(100) },
    });
    expect(md(Comp).__ecstatic_column_ctor?.[0]).toBe(Int32Array);
  });

  it("stores column constructor for u8", () => {
    const { WidthU8Ctor: Comp } = components({
      WidthU8Ctor: { x: u8(5) },
    });
    expect(md(Comp).__ecstatic_column_ctor?.[0]).toBe(Uint8Array);
  });
});

describe("isComponentDescriptor", () => {
  it("returns true for valid component descriptors", () => {
    const { DescValid: Comp } = components({ DescValid: { x: 0 } });
    expect(isComponentDescriptor(Comp)).toBe(true);
  });

  it("returns false for null", () => {
    expect(isComponentDescriptor(null)).toBe(false);
  });

  it("returns false for undefined", () => {
    expect(isComponentDescriptor(undefined)).toBe(false);
  });

  it("returns false for primitives", () => {
    expect(isComponentDescriptor("string")).toBe(false);
    expect(isComponentDescriptor(42)).toBe(false);
    expect(isComponentDescriptor(true)).toBe(false);
  });

  it("returns false for arrays", () => {
    expect(isComponentDescriptor([1, 2, 3])).toBe(false);
  });

  it("returns false for plain objects without descriptor properties", () => {
    expect(isComponentDescriptor({ x: 0, y: 0 })).toBe(false);
  });

  it("returns false for objects with partial descriptor properties", () => {
    expect(
      isComponentDescriptor({
        __ecstatic_name: "Partial",
        // missing __ecstatic_fields
      }),
    ).toBe(false);
  });
});

describe("isFieldDescriptor", () => {
  it("returns true for field descriptors", () => {
    const { FieldDesc: Comp } = components({ FieldDesc: { x: 0 } });
    const field = (Comp as unknown as Record<string, unknown>).x;
    expect(isFieldDescriptor(field)).toBe(true);
  });

  it("returns false for null", () => {
    expect(isFieldDescriptor(null)).toBe(false);
  });

  it("returns false for undefined", () => {
    expect(isFieldDescriptor(undefined)).toBe(false);
  });

  it("returns false for primitives", () => {
    expect(isFieldDescriptor("string")).toBe(false);
    expect(isFieldDescriptor(42)).toBe(false);
  });

  it("returns false for arrays", () => {
    expect(isFieldDescriptor([1, 2])).toBe(false);
  });

  it("returns false for objects without field descriptor properties", () => {
    expect(isFieldDescriptor({ x: 0 })).toBe(false);
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
