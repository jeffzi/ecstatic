import { describe, expect, it } from "vitest";

import {
  component,
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
} from "../../src/component.js";
import { asMutableDescriptor } from "./fixtures.js";

describe("component", () => {
  it("returns a descriptor object", () => {
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
    expect(asMutableDescriptor(Sprite).__ecstatic_defaults["image"]).toBe("");
    expect(asMutableDescriptor(Sprite).__ecstatic_defaults["frame"]).toBe(0);
    expect(asMutableDescriptor(Sprite).__ecstatic_defaults["flip"]).toBe(false);
  });

  it("tags are 0-field descriptors", () => {
    const { ComponentSpecStunned: Stunned } = components({ ComponentSpecStunned: {} });
    expect(asMutableDescriptor(Stunned).__ecstatic_name).toBe("ComponentSpecStunned");
    expect(asMutableDescriptor(Stunned).__ecstatic_fields.length).toBe(0);
  });

  it("throws on shape conflict for different fields", () => {
    components({ ComponentSpecDuplicateName: { x: 0 } });

    expect(() => {
      components({ ComponentSpecDuplicateName: { y: 0 } });
    }).toThrow("component shape conflict: ComponentSpecDuplicateName");
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
      }).toThrow("must be a valid ASCII identifier");
    });

    it("rejects field names containing a hyphen", () => {
      expect(() => {
        components({ ComponentSpecValidation_hyphen: { "field-name": 0 } });
      }).toThrow("must be a valid ASCII identifier");
    });

    it("rejects field names containing a space", () => {
      expect(() => {
        components({ ComponentSpecValidation_space: { "field name": 0 } });
      }).toThrow("must be a valid ASCII identifier");
    });

    it("rejects field names with non-ASCII characters", () => {
      expect(() => {
        components({ ComponentSpecValidation_nonascii: { café: 0 } });
      }).toThrow("must be a valid ASCII identifier");
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

    it("errors on object default that is not ref()", () => {
      expect(() => {
        // @ts-expect-error object defaults are rejected at the type level too
        components({ ComponentSpecRefRejectObject: { data: { a: 1 } } });
      }).toThrow(/object defaults are not supported/);
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

  describe("idempotent registration", () => {
    it.each([
      { label: "a tag", name: "IdempotentSpec_Tag", shape: {} },
      { label: "fields", name: "IdempotentSpec_Fields", shape: { x: 0, y: 0 } },
      { label: "ref fields", name: "IdempotentSpec_Ref", shape: { r: ref() } },
      { label: "width-marked fields", name: "IdempotentSpec_F32", shape: { x: f32(1) } },
    ])(
      "returns the identical descriptor for $label re-declared with equal shape",
      ({ name, shape }) => {
        const first = component(name, shape);
        const second = component(name, shape);
        expect(second).toBe(first);
      },
    );

    it.each([
      {
        label: "default values differ",
        name: "IdempotentSpec_DefaultConflict",
        first: { x: 0 },
        second: { x: 1 },
      },
      {
        label: "ref-ness differs",
        name: "IdempotentSpec_RefMismatch",
        first: { x: ref() },
        second: { x: 0 },
      },
      {
        label: "width markers differ",
        name: "IdempotentSpec_WidthMismatch",
        first: { x: f32(1) },
        second: { x: f64(1) },
      },
    ])("throws on shape conflict when $label", ({ name, first, second }) => {
      component(name, first);
      expect(() => {
        component(name, second);
      }).toThrow(`component shape conflict: ${name}`);
    });

    it("shape-conflict throw does not alter the existing descriptor", () => {
      const original = component("IdempotentSpec_Preserved", { x: 0 });
      const desc = asMutableDescriptor(original);
      const fieldsBefore = [...desc.__ecstatic_fields];
      const defaultsBefore = { ...desc.__ecstatic_defaults };

      expect(() => {
        component("IdempotentSpec_Preserved", { y: 0 });
      }).toThrow("component shape conflict: IdempotentSpec_Preserved");

      expect(desc.__ecstatic_fields).toStrictEqual(fieldsBefore);
      expect(desc.__ecstatic_defaults).toStrictEqual(defaultsBefore);
    });

    describe("with array defaults", () => {
      /** Registers a component whose defaults include arrays, which `FieldDefault` excludes. */
      function componentWithArrayDefaults(name: string, fields: object): unknown {
        // @ts-expect-error array defaults sit outside FieldDefault but are accepted at runtime
        return component(name, fields);
      }

      it.each([
        {
          label: "an empty array",
          name: "IdempotentSpec_EmptyArray",
          freshShape: () => ({ tags: [] }),
        },
        {
          label: "a numeric array",
          name: "IdempotentSpec_NumericArray",
          freshShape: () => ({ tags: [1, 2] }),
        },
        {
          label: "a nested array",
          name: "IdempotentSpec_NestedArray",
          freshShape: () => ({ grid: [[1, 2], [3]] }),
        },
        {
          label: "an array of records",
          name: "IdempotentSpec_RecordArray",
          freshShape: () => ({ points: [{ x: 1, y: [2] }] }),
        },
      ])(
        "returns the identical descriptor when $label is re-declared as a fresh equal literal",
        ({ name, freshShape }) => {
          const original = componentWithArrayDefaults(name, freshShape());

          const redeclared = componentWithArrayDefaults(name, freshShape());

          expect(redeclared).toBe(original);
        },
      );

      it.each([
        {
          label: "an array gains an element",
          name: "IdempotentSpec_ArrayLength",
          first: { tags: [1] },
          second: { tags: [1, 2] },
        },
        {
          label: "an empty array becomes non-empty",
          name: "IdempotentSpec_ArrayEmptyToFilled",
          first: { tags: [] },
          second: { tags: [0] },
        },
        {
          label: "a nested element differs",
          name: "IdempotentSpec_NestedArrayValue",
          first: { grid: [[1, 2], [3]] },
          second: { grid: [[1, 2], [4]] },
        },
        {
          label: "a record element value differs",
          name: "IdempotentSpec_RecordArrayValue",
          first: { points: [{ x: 1 }] },
          second: { points: [{ x: 2 }] },
        },
        {
          label: "a record element gains a key",
          name: "IdempotentSpec_RecordArrayKey",
          first: { points: [{ x: 1 }] },
          second: { points: [{ x: 1, y: 2 }] },
        },
        {
          label: "an empty array element becomes an empty record",
          name: "IdempotentSpec_ArrayVersusRecord",
          first: { slots: [[]] },
          second: { slots: [{}] },
        },
      ])("throws on shape conflict when $label", ({ name, first, second }) => {
        componentWithArrayDefaults(name, first);

        expect(() => {
          componentWithArrayDefaults(name, second);
        }).toThrow(`component shape conflict: ${name}`);
      });
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
    expect(asMutableDescriptor(Comp).__ecstatic_defaults["value"]).toBe(value);
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
    }).toThrow(/component fields must be an object/);
  });

  it("rejects Map as component fields argument", () => {
    expect(() => {
      components({
        ComponentSpecValidation_map: new Map(),
      } as unknown as Record<string, Record<string, FieldDefault>>);
    }).toThrow(/component fields must be an object/);
  });

  it("rejects Set as component fields argument", () => {
    expect(() => {
      components({
        ComponentSpecValidation_set: new Set(),
      } as unknown as Record<string, Record<string, FieldDefault>>);
    }).toThrow(/component fields must be an object/);
  });
});
