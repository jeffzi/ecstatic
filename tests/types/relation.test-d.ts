import { describe, expectTypeOf, it } from "vitest";

import {
  type Component,
  type ComponentDescriptor,
  type FieldDescriptor,
  component,
  ref,
} from "../../src/component.js";
import type { EntityId } from "../../src/entity-id.js";
import {
  type Relation,
  type RelationConstraints,
  type RelationFields,
  relation,
} from "../../src/relation.js";

interface Handle {
  readonly kind: "handle";
}

const RelTypeSpec_Comp = component("RelTypeSpec_Comp", { x: 0 });
const RelTypeSpec_CompB = component("RelTypeSpec_CompB", { y: 0 });

const Pure = relation("RelTypeSpec_Pure");
const Data = relation("RelTypeSpec_Data", { offsetX: 0, label: "" });
const Constrained = relation("RelTypeSpec_Constrained", [RelTypeSpec_Comp]);
const Full = relation("RelTypeSpec_Full", [RelTypeSpec_Comp], { strength: 0 });

describe("relation", () => {
  it("is a valid component descriptor in every form", () => {
    expectTypeOf(Pure).toExtend<ComponentDescriptor>();
    expectTypeOf(Data).toExtend<ComponentDescriptor>();
    expectTypeOf(Constrained).toExtend<ComponentDescriptor>();
    expectTypeOf(Full).toExtend<ComponentDescriptor>();
    expectTypeOf(Full).toExtend<Component>();
  });

  it("types Rel.target as a branded EntityId-valued field descriptor", () => {
    expectTypeOf(Pure.target).toExtend<FieldDescriptor<EntityId>>();
    expectTypeOf(Data.target).toExtend<FieldDescriptor<EntityId>>();
    // The write-guard brand is what lets set() reject target writes
    expectTypeOf(Pure.target.__ecstatic_relation_target).toEqualTypeOf<true>();
  });

  it("types data fields as field descriptors", () => {
    expectTypeOf(Data.offsetX).toEqualTypeOf<FieldDescriptor<number>>();
    expectTypeOf(Data.label).toEqualTypeOf<FieldDescriptor<string>>();
    expectTypeOf(Full.strength).toEqualTypeOf<FieldDescriptor<number>>();
  });

  it("rejects a target key in defaults at compile time", () => {
    // @ts-expect-error target is a reserved relation field name
    relation("RelTypeSpec_BadTarget2", { target: 0 });
    // @ts-expect-error target is a reserved relation field name
    relation("RelTypeSpec_BadTarget3", [RelTypeSpec_Comp], { target: 0 });
  });

  it("distinguishes relations from plain components", () => {
    expectTypeOf(RelTypeSpec_Comp).not.toExtend<Relation>();
    expectTypeOf(Pure).toExtend<Relation>();
  });
});

describe("RelationConstraints", () => {
  it("extracts the constraint tuple", () => {
    expectTypeOf<RelationConstraints<typeof Constrained>>().toEqualTypeOf<
      [typeof RelTypeSpec_Comp]
    >();
    expectTypeOf<RelationConstraints<typeof Full>>().toEqualTypeOf<[typeof RelTypeSpec_Comp]>();
    expectTypeOf<RelationConstraints<typeof Pure>>().toEqualTypeOf<[]>();
  });
});

describe("RelationFields", () => {
  it("extracts the data-fields record without target", () => {
    expectTypeOf<RelationFields<typeof Data>>().toEqualTypeOf<{
      offsetX: number;
      label: string;
    }>();
    // oxlint-disable-next-line typescript/no-generated-empty-object-type -- the assertion is that a pure link has no data fields
    expectTypeOf<keyof RelationFields<typeof Pure>>().toBeNever();
  });
});

describe("ref fields in relation", () => {
  const RefRel = relation("RelTypeSpec_RefRel", [], { handle: ref<Handle>(), amount: 0 });

  it("types the ref field descriptor value as T | undefined", () => {
    expectTypeOf(RefRel.handle).toEqualTypeOf<FieldDescriptor<Handle | undefined>>();
  });

  it("types a scalar field descriptor normally", () => {
    expectTypeOf(RefRel.amount).toEqualTypeOf<FieldDescriptor<number>>();
  });

  it("rejects object defaults in relation()", () => {
    // @ts-expect-error object defaults are not supported — use ref<T>()
    relation("RelTypeSpec_BadObj", { nested: { x: 1 } });
    // @ts-expect-error object defaults are not supported — use ref<T>()
    relation("RelTypeSpec_BadObj2", [RelTypeSpec_Comp], { nested: { x: 1 } });
  });

  it("composes ref fields with constraints", () => {
    const ConstrainedRef = relation("RelTypeSpec_ConstrainedRef", [RelTypeSpec_Comp], {
      handle: ref<Handle>(),
    });
    expectTypeOf<RelationConstraints<typeof ConstrainedRef>>().toEqualTypeOf<
      [typeof RelTypeSpec_Comp]
    >();
    expectTypeOf(ConstrainedRef.handle).toEqualTypeOf<FieldDescriptor<Handle | undefined>>();
  });
});

describe("multi-component constraint tuple", () => {
  const MultiConstrained = relation("RelTypeSpec_Multi", [RelTypeSpec_Comp, RelTypeSpec_CompB]);

  it("produces the two-element constraint tuple", () => {
    expectTypeOf<RelationConstraints<typeof MultiConstrained>>().toEqualTypeOf<
      [typeof RelTypeSpec_Comp, typeof RelTypeSpec_CompB]
    >();
  });
});
