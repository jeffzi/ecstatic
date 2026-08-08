import { describe, expect, it } from "vitest";

import { component, components, type FieldDefault } from "../src/component.js";
import { asMutableDescriptor } from "./fixtures.js";

describe("components", () => {
  it("returns descriptors keyed by component name", () => {
    const defs = components({
      ComponentsSpecPosition: { x: 0, y: 0 },
      ComponentsSpecVelocity: { vx: 0, vy: 0 },
    });

    expect(asMutableDescriptor(defs.ComponentsSpecPosition).__ecstatic_name).toBe(
      "ComponentsSpecPosition",
    );
    expect(asMutableDescriptor(defs.ComponentsSpecPosition).__ecstatic_fields[0]).toBe("x");
    expect(asMutableDescriptor(defs.ComponentsSpecPosition).__ecstatic_fields[1]).toBe("y");
    expect(asMutableDescriptor(defs.ComponentsSpecVelocity).__ecstatic_defaults.vx).toBe(0);
  });

  it("uses empty objects as tag descriptors", () => {
    const defs = components({ ComponentsSpecStunned: {} });

    expect(asMutableDescriptor(defs.ComponentsSpecStunned).__ecstatic_name).toBe(
      "ComponentsSpecStunned",
    );
    expect(asMutableDescriptor(defs.ComponentsSpecStunned).__ecstatic_fields.length).toBe(0);
  });

  it("returns a single descriptor from field defaults", () => {
    const Position = component("ComponentsSpecSinglePosition", { x: 0, y: 0 });

    expect(asMutableDescriptor(Position).__ecstatic_name).toBe("ComponentsSpecSinglePosition");
    expect(asMutableDescriptor(Position).__ecstatic_fields[0]).toBe("x");
    expect(asMutableDescriptor(Position).__ecstatic_fields[1]).toBe("y");
    expect(asMutableDescriptor(Position).__ecstatic_defaults.x).toBe(0);
  });

  it("uses omitted fields as a tag descriptor", () => {
    const Stunned = component("ComponentsSpecSingleStunned");

    expect(asMutableDescriptor(Stunned).__ecstatic_name).toBe("ComponentsSpecSingleStunned");
    expect(asMutableDescriptor(Stunned).__ecstatic_fields.length).toBe(0);
  });

  it("rejects duplicate names across batched declarations", () => {
    components({ ComponentsSpecDuplicate: { x: 0 } });

    expect(() => {
      components({ ComponentsSpecDuplicate: { y: 0 } });
    }).toThrow(/component name already registered/);
  });

  it("rejects duplicate names across singular and batched declarations", () => {
    component("ComponentsSpecDuplicateSingle", { x: 0 });

    expect(() => {
      components({ ComponentsSpecDuplicateSingle: { y: 0 } });
    }).toThrow(/component name already registered/);
  });

  it("rejects invalid single-component field defaults without reserving the name", () => {
    expect(() => {
      component("ComponentsSpecInvalidSingle", 0 as unknown as Record<string, FieldDefault>);
    }).toThrow(/component fields must be an object/);

    const Position = component("ComponentsSpecInvalidSingle", { x: 0, y: 0 });
    expect(asMutableDescriptor(Position).__ecstatic_name).toBe("ComponentsSpecInvalidSingle");
    expect(asMutableDescriptor(Position).__ecstatic_fields.length).toBe(2);
  });

  it("rejects invalid batched component field defaults without reserving the name", () => {
    expect(() => {
      components({
        ComponentsSpecInvalidBatch: false as unknown as Record<string, FieldDefault>,
      });
    }).toThrow(/component fields must be an object/);

    const defs = components({
      ComponentsSpecInvalidBatch: { x: 0, y: 0 },
    });
    expect(asMutableDescriptor(defs.ComponentsSpecInvalidBatch).__ecstatic_name).toBe(
      "ComponentsSpecInvalidBatch",
    );
    expect(asMutableDescriptor(defs.ComponentsSpecInvalidBatch).__ecstatic_fields.length).toBe(2);
  });

  it("rejects mixed batched component field defaults without partially reserving names", () => {
    const validName = "ComponentsSpecAtomicBatchValid";
    const invalidName = "ComponentsSpecAtomicBatchInvalid";

    expect(() => {
      components({
        [validName]: { x: 0, y: 0 },
        [invalidName]: false as unknown as Record<string, FieldDefault>,
      });
    }).toThrow(/component fields must be an object/);

    const valid = component(validName, { x: 0, y: 0 });
    expect(asMutableDescriptor(valid).__ecstatic_name).toBe(validName);

    const invalid = component(invalidName, { vx: 0, vy: 0 });
    expect(asMutableDescriptor(invalid).__ecstatic_name).toBe(invalidName);
  });
});
