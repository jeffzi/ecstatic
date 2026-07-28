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
 * Casts a component descriptor to a mutable {@link DescriptorView}, throwing
 * if the value isn't a descriptor. Used by tests that mutate descriptor
 * internals (e.g. `__ecstatic_name`) to exercise edge cases the public API
 * can't reach.
 */
export const asMutableDescriptor = (c: unknown): DescriptorView => {
  if (isDescriptorView(c)) return c;
  throw new Error(`Expected DescriptorView, got ${typeof c}`);
};
