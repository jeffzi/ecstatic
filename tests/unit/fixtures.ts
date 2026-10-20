import { entityIndex } from "../../src/ecstatic/entity-id.js";

/** Dense row of a live entity: sparse lookup by entity index. */
export function rowOf(storage: { sparse: Int32Array }, id: number): number {
  const row = storage.sparse[entityIndex(id)];
  if (row == null) throw new Error("entity index out of bounds");
  return row;
}

/**
 * Mutable view over a `ComponentDescriptor`'s internal fields, for tests that
 * need to poke at descriptor internals (e.g. renaming a component to a
 * reserved name) without a raw `as unknown as Record<string, unknown>` cast.
 */
export interface DescriptorView {
  __ecstatic_name: string;
  __ecstatic_fields: string[];
  __ecstatic_defaults: Record<string, unknown>;
  __ecstatic_default_values: unknown[];
  __ecstatic_is_reference: (boolean | undefined)[];
  __ecstatic_component_key: string;
  __ecstatic_column_ctor?: (
    | typeof Float64Array
    | typeof Float32Array
    | typeof Int32Array
    | typeof Int16Array
    | typeof Int8Array
    | typeof Uint32Array
    | typeof Uint16Array
    | typeof Uint8Array
    | undefined
  )[];
}

/** Type guard narrowing an unknown value to {@link DescriptorView}. */
export function isDescriptorView(v: unknown): v is DescriptorView {
  return (
    v !== null &&
    typeof v === "object" &&
    "__ecstatic_name" in v &&
    "__ecstatic_fields" in v &&
    "__ecstatic_defaults" in v
  );
}

/**
 * Narrows a component descriptor to a mutable {@link DescriptorView}, for tests
 * that mutate descriptor internals (e.g. `__ecstatic_name`) to exercise edge
 * cases the public API can't reach.
 *
 * @param c - Value expected to be a component descriptor.
 * @returns The same object, typed as a mutable {@link DescriptorView}.
 * @throws Error when `c` is not a descriptor.
 */
export const asMutableDescriptor = (c: unknown): DescriptorView => {
  if (isDescriptorView(c)) return c;
  throw new Error(`Expected DescriptorView, got ${typeof c}`);
};
