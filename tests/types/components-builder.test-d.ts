import { describe, expectTypeOf, it } from "vitest";
import {
  archetype,
  type Component,
  component,
  components,
  createWorld,
  type FieldValue,
  f32,
  i16,
  type RefMarker,
  ref,
  register,
  set,
  spawn,
  type Tag,
  u8,
} from "../../src/index.js";

// Test fixture: a simple reference type
interface Handle {
  readonly __handle: unique symbol;
}

describe("components", () => {
  it("infers component descriptors from object keys", () => {
    const defs = components({ CbPosition: { x: 0, y: 0 } });

    expectTypeOf(defs.CbPosition).toEqualTypeOf<
      Component<"CbPosition", { x: number; y: number }>
    >();
  });

  it("infers tags from empty objects", () => {
    const defs = components({ CbStunned: {} });

    expectTypeOf(defs.CbStunned).toEqualTypeOf<Tag<"CbStunned">>();
  });

  it("rejects null entries", () => {
    // @ts-expect-error null entries are not valid field records
    components({ CbBad: null });
  });
});

describe("component", () => {
  it("infers a data component from field defaults", () => {
    const Pos = component("CbSinglePosition", { x: 0, y: 0 });

    expectTypeOf(Pos).toEqualTypeOf<Component<"CbSinglePosition", { x: number; y: number }>>();
  });

  it("infers a tag when fields are omitted", () => {
    const Stunned = component("CbSingleStunned");

    expectTypeOf(Stunned).toEqualTypeOf<Tag<"CbSingleStunned">>();
  });

  it("infers a tag from empty fields", () => {
    const OnFire = component("CbSingleOnFire", {});

    expectTypeOf(OnFire).toEqualTypeOf<Tag<"CbSingleOnFire">>();
  });

  it("rejects null fields", () => {
    // @ts-expect-error null fields are not a valid field record
    component("CbSingleBad", null);
  });
});

describe("RefMarker<T> and ref<T>()", () => {
  it("ref<T>() returns RefMarker<T>", () => {
    const refMarker = ref<Handle>();

    expectTypeOf(refMarker).toEqualTypeOf<RefMarker<Handle>>();
  });

  it("allows component with ref field", () => {
    const WithHandle = component("CbWithHandle", { handle: ref<Handle>() });

    expectTypeOf(WithHandle).toEqualTypeOf<
      Component<"CbWithHandle", { handle: Handle | undefined }>
    >();
  });

  it("rejects table defaults in component", () => {
    // @ts-expect-error table defaults not allowed in components
    component("CbWithTable", { data: { nested: 1 } });
  });

  it("rejects object defaults in component", () => {
    // @ts-expect-error table/object defaults not allowed — only scalar + RefMarker
    component("CbBadDefaults", { config: { a: 1, b: 2 } });
  });
});

describe("ComponentFields tightening — scalar + RefMarker only", () => {
  it("allows scalar field defaults", () => {
    const Scalars = component("CbScalars", { x: 0, y: 0, name: "", active: true });

    expectTypeOf(Scalars).toEqualTypeOf<
      Component<"CbScalars", { active: boolean; name: string; x: number; y: number }>
    >();
  });

  it("allows ref field defaults", () => {
    const WithRef = component("CbWithRef", { handle: ref<Handle>() });

    expectTypeOf(WithRef).toEqualTypeOf<Component<"CbWithRef", { handle: Handle | undefined }>>();
  });

  it("mixes scalar and ref fields", () => {
    const Mixed = component("CbMixed", {
      positionX: 0,
      handle: ref<Handle>(),
      name: "",
    });

    expectTypeOf(Mixed).toEqualTypeOf<
      Component<"CbMixed", { handle: Handle | undefined; name: string; positionX: number }>
    >();
  });
});

describe("width markers infer number field types", () => {
  it("width-marked defaults produce number fields", () => {
    const Packed = component("CbPacked", { a: f32(0), b: i16(1), c: u8(2) });

    expectTypeOf(Packed).toEqualTypeOf<
      Component<"CbPacked", { a: number; b: number; c: number }>
    >();
  });
});

describe("ref field unwrapping in FieldValue", () => {
  it("RefMarker<T> unwraps to T | undefined", () => {
    const WithHandle = component("CbFvHandle", { handle: ref<Handle>() });

    expectTypeOf<FieldValue<typeof WithHandle.handle>>().toEqualTypeOf<Handle | undefined>();
  });

  it("scalar field remains as-is in FieldValue", () => {
    const Pos = component("CbFvPos", { x: 0 });

    expectTypeOf<FieldValue<typeof Pos.x>>().toEqualTypeOf<number>();
  });
});

describe("set with ref and scalar fields", () => {
  it("set accepts undefined for ref field", () => {
    const WithHandle = component("CbSetHandle", { handle: ref<Handle>() });

    const world = createWorld();
    const storage = register(world, archetype([WithHandle]));
    const id = spawn(storage);

    set(storage, id, WithHandle.handle, undefined);
  });

  it("set rejects undefined for scalar field", () => {
    const WithNumber = component("CbSetNumber", { count: 0 });

    const world = createWorld();
    const storage = register(world, archetype([WithNumber]));
    const id = spawn(storage);

    // @ts-expect-error scalar field rejects undefined
    set(storage, id, WithNumber.count, undefined);
  });
});
