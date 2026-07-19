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

export function isDescriptorView(v: unknown): v is DescriptorView {
  return (
    v !== null &&
    typeof v === "object" &&
    "__ecstatic_name" in v &&
    "__ecstatic_fields" in v &&
    "__ecstatic_defaults" in v
  );
}

export const md = (c: unknown): DescriptorView => {
  if (isDescriptorView(c)) return c;
  throw new Error(`Expected DescriptorView, got ${typeof c}`);
};
