import { describe, expectTypeOf, it } from "vitest";

import {
  type Component,
  type ComponentDescriptor,
  type FieldDescriptor,
  component,
} from "../../src/component.js";
import type { EntityId } from "../../src/entity-id.js";
import {
  type Relation,
  type RelationConstraints,
  type RelationFields,
  relation,
} from "../../src/relation.js";

const RelTypeSpec_Comp = component("RelTypeSpec_Comp", { x: 0 });

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
    expectTypeOf<keyof RelationFields<typeof Pure>>().toBeNever();
  });
});
