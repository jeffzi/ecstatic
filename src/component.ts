/**
 * Component system: define components with typed fields and defaults.
 * Module-level name registry prevents duplicate component names.
 * Fields are validated against the pattern ^[A-Za-z_][A-Za-z0-9_]*$.
 * Field order is deterministic (byte-order sorted).
 * Reference fields hold entity IDs and are unwrapped in APIs.
 * Width markers (f32, i32, etc.) select TypedArray constructors for storage.
 */

/** Module-level name registry to prevent duplicate components */
const seenNames = new Set<string>();

/** Module-level sentinel for reference field markers, compared by identity */
const REF_SENTINEL: Record<string, never> = {};

/** Width marker sentinels for column type selection */
const F32_MARKER = Symbol("f32");
const F64_MARKER = Symbol("f64");
const I32_MARKER = Symbol("i32");
const I16_MARKER = Symbol("i16");
const I8_MARKER = Symbol("i8");
const U32_MARKER = Symbol("u32");
const U16_MARKER = Symbol("u16");
const U8_MARKER = Symbol("u8");

type WidthMarkerType =
  | typeof F32_MARKER
  | typeof F64_MARKER
  | typeof I32_MARKER
  | typeof I16_MARKER
  | typeof I8_MARKER
  | typeof U32_MARKER
  | typeof U16_MARKER
  | typeof U8_MARKER;

/** Opaque marker returned by the width constructors (f32, i32, etc.), carrying the selected storage width and the wrapped value. */
export interface WidthMarker {
  readonly __ecstatic_width_marker: WidthMarkerType;
  readonly value: number;
}

/** True if a value has the shape of a WidthMarker, i.e. was produced by a width constructor. */
function isWidthMarker(v: unknown): v is WidthMarker {
  return (
    v !== null &&
    typeof v === "object" &&
    "__ecstatic_width_marker" in v &&
    "value" in v &&
    typeof v.value === "number"
  );
}

/** Wrap a numeric default to use Float32Array storage in SoA columns. */
export function f32(value: number): WidthMarker {
  return { __ecstatic_width_marker: F32_MARKER, value };
}

/** Wrap a numeric default to use Float64Array storage in SoA columns. */
export function f64(value: number): WidthMarker {
  return { __ecstatic_width_marker: F64_MARKER, value };
}

/** Wrap a numeric default to use Int32Array storage in SoA columns. */
export function i32(value: number): WidthMarker {
  return { __ecstatic_width_marker: I32_MARKER, value };
}

/** Wrap a numeric default to use Int16Array storage in SoA columns. */
export function i16(value: number): WidthMarker {
  return { __ecstatic_width_marker: I16_MARKER, value };
}

/** Wrap a numeric default to use Int8Array storage in SoA columns. */
export function i8(value: number): WidthMarker {
  return { __ecstatic_width_marker: I8_MARKER, value };
}

/** Wrap a numeric default to use Uint32Array storage in SoA columns. */
export function u32(value: number): WidthMarker {
  return { __ecstatic_width_marker: U32_MARKER, value };
}

/** Wrap a numeric default to use Uint16Array storage in SoA columns. */
export function u16(value: number): WidthMarker {
  return { __ecstatic_width_marker: U16_MARKER, value };
}

/** Wrap a numeric default to use Uint8Array storage in SoA columns. */
export function u8(value: number): WidthMarker {
  return { __ecstatic_width_marker: U8_MARKER, value };
}

/** TypedArray constructors selectable as numeric SoA columns. */
export type NumericColumnCtor =
  | typeof Float64Array
  | typeof Float32Array
  | typeof Int32Array
  | typeof Int16Array
  | typeof Int8Array
  | typeof Uint32Array
  | typeof Uint16Array
  | typeof Uint8Array;

/** Throws if the marker is not one of the eight known width sentinels. */
function getColumnCtorForMarker(marker: WidthMarkerType): NumericColumnCtor {
  switch (marker) {
    case F32_MARKER:
      return Float32Array;
    case F64_MARKER:
      return Float64Array;
    case I32_MARKER:
      return Int32Array;
    case I16_MARKER:
      return Int16Array;
    case I8_MARKER:
      return Int8Array;
    case U32_MARKER:
      return Uint32Array;
    case U16_MARKER:
      return Uint16Array;
    case U8_MARKER:
      return Uint8Array;
    default:
      throw new Error("unknown width marker");
  }
}

/** Select the default TypedArray column constructor for an unmarked scalar default. */
function defaultColumnCtor(value: unknown): NumericColumnCtor | undefined {
  if (typeof value === "number") {
    return Float64Array;
  }
  if (typeof value === "boolean") {
    return Uint8Array;
  }
  return undefined; // strings and others use plain arrays
}

const FIELD_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Validates a field name against `^[A-Za-z_][A-Za-z0-9_]*$`.
 *
 * Shared by `component()` and `resource()` so both namespaces accept exactly
 * the same field names; `kind` only selects the noun in the error message.
 *
 * @param kind - Declaration kind naming the field group.
 * @param ownerName - Name of the component or resource declaring the field.
 * @param fieldName - Candidate field name.
 */
export function validateFieldName(
  kind: "component" | "resource",
  ownerName: string,
  fieldName: unknown,
): asserts fieldName is string {
  if (typeof fieldName !== "string") {
    throw new Error(`${kind} field names must be strings: ${ownerName}`);
  }

  if (!FIELD_NAME_PATTERN.test(fieldName)) {
    throw new Error(
      `${kind} field name must be a valid ASCII identifier (^[A-Za-z_][A-Za-z0-9_]*$): ${ownerName}.${fieldName}`,
    );
  }
}

/** True for non-null, non-array, non-Date/Map/Set objects. */
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return (
    typeof v === "object" &&
    v !== null &&
    !Array.isArray(v) &&
    !(v instanceof Date) &&
    !(v instanceof Map) &&
    !(v instanceof Set)
  );
}

/** Throws unless fields is a plain object with all-valid field names; returns it unchanged otherwise. */
function validateFields(componentName: string, fields: unknown): Record<string, unknown> {
  if (!isPlainObject(fields)) {
    throw new Error(`component fields must be an object: ${componentName}`);
  }

  const defaults = fields;
  for (const fieldName in defaults) {
    validateFieldName("component", componentName, fieldName);
  }

  return defaults;
}

/** Throws if the name collides with any prior component() or components() call — module-global uniqueness. */
function assertNameAvailable(name: string): void {
  if (seenNames.has(name)) {
    throw new Error(`component name already registered: ${name}`);
  }
}

/** Assumes defaults was already produced by validateFields — does not re-validate field names. */
function descriptorFromDefaults(
  name: string,
  defaults: Record<string, unknown>,
): Record<string, unknown> {
  // Sort fields by byte order (ASCII byte values, not locale-dependent)
  // JavaScript's default string sort is byte-order (UTF-16 code unit order)
  // oxlint-disable-next-line unicorn/no-array-sort -- in-place sort of a fresh array; toSorted() would copy for no reason
  const fields = Object.keys(defaults).sort();

  const defaultValues: unknown[] = [];
  const isReference: (boolean | undefined)[] = [];
  const columnCtors: (NumericColumnCtor | undefined)[] = [];

  // Normalize defaults: extract values from width markers
  const normalizedDefaults: Record<string, unknown> = {};

  for (const fieldName of fields) {
    const defaultValue = defaults[fieldName];

    if (defaultValue === REF_SENTINEL) {
      defaultValues.push(undefined);
      isReference.push(true);
      columnCtors.push(undefined);
      normalizedDefaults[fieldName] = undefined;
    } else if (isWidthMarker(defaultValue)) {
      defaultValues.push(defaultValue.value);
      isReference.push(false);
      columnCtors.push(getColumnCtorForMarker(defaultValue.__ecstatic_width_marker));
      normalizedDefaults[fieldName] = defaultValue.value;
    } else if (
      typeof defaultValue === "object" &&
      defaultValue !== null &&
      !Array.isArray(defaultValue)
    ) {
      throw new Error(
        "ecstatic: object defaults are not supported; declare the field with ref<T>() and initialize it explicitly",
      );
    } else {
      // Scalar default (number, string, boolean, array)
      defaultValues.push(defaultValue);
      isReference.push(false);
      columnCtors.push(defaultColumnCtor(defaultValue));
      normalizedDefaults[fieldName] = defaultValue;
    }
  }

  const descriptor: Record<string, unknown> = {
    __ecstatic_name: name,
    __ecstatic_fields: fields,
    __ecstatic_defaults: normalizedDefaults,
    __ecstatic_default_values: defaultValues,
    __ecstatic_is_reference: isReference,
    __ecstatic_component_key: `${name.length}:${name}`,
    __ecstatic_column_ctor: columnCtors,
  };

  for (const fieldName of fields) {
    descriptor[fieldName] = {
      __ecstatic_component: descriptor,
      __ecstatic_field: fieldName,
    };
  }

  return descriptor;
}

/**
 * Create a reference-type marker for use in component field defaults.
 * Reference fields are optional by nature — they unwrap to T | undefined in all APIs.
 * Used for fields that hold entity IDs, handles, or other typed references.
 */
export function ref<T = unknown>(): RefMarker<T> {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- branded type boundary
  return REF_SENTINEL as unknown as RefMarker<T>;
}

/**
 * Shared descriptor-construction path for component() and relation():
 * validates the name and fields, registers the name (relations share the
 * component namespace), and builds the descriptor.
 */
export function createDescriptor(name: string, rawFields: unknown): Record<string, unknown> {
  assertNameAvailable(name);
  const defaults = validateFields(name, rawFields);
  const descriptor = descriptorFromDefaults(name, defaults);
  seenNames.add(name);
  return descriptor;
}

/**
 * Register a single component descriptor from a name and optional field defaults.
 * If fields is omitted, the result is a tag (0-field component).
 */
export function component<N extends string>(name: N): Tag<N>;
export function component<N extends string, T extends Record<string, FieldDefault>>(
  name: N,
  fields: T,
): keyof T extends never ? Tag<N> : Component<N, InferFields<T>>;
export function component(name: string, fields?: Record<string, unknown>): unknown {
  return createDescriptor(name, fields ?? {});
}

/**
 * Register multiple component types from a single name-keyed declaration object.
 * Validates all components before registering any names (atomic validation).
 */
export function components<T extends Record<string, Record<string, FieldDefault>>>(
  defs: T,
): {
  [K in keyof T]: keyof T[K] extends never
    ? Tag<K & string>
    : Component<K & string, InferFields<T[K]>>;
} {
  const result: Record<string, unknown> = {};
  const descriptorsByName = new Map<string, Record<string, unknown>>();

  // Validate and build all descriptors before registering any names (atomic)
  for (const name in defs) {
    assertNameAvailable(name);
    const defaults = validateFields(name, defs[name]);
    descriptorsByName.set(name, descriptorFromDefaults(name, defaults));
  }

  // All descriptors built successfully: register names and publish results
  for (const [name, descriptor] of descriptorsByName) {
    seenNames.add(name);
    result[name] = descriptor;
  }

  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- opaque type return
  return result as unknown as {
    [K in keyof T]: keyof T[K] extends never
      ? Tag<K & string>
      : Component<K & string, InferFields<T[K]>>;
  };
}

/** Duck-type predicate: check if value has the shape of a ComponentDescriptor */
export function isComponentDescriptor(value: unknown): value is ComponentDescriptor {
  if (!isPlainObject(value)) {
    return false;
  }

  return (
    typeof value.__ecstatic_name === "string" &&
    Array.isArray(value.__ecstatic_fields) &&
    Array.isArray(value.__ecstatic_default_values) &&
    Array.isArray(value.__ecstatic_is_reference)
  );
}

/** Duck-type predicate: check if value has the shape of a FieldDescriptor */
export function isFieldDescriptor(value: unknown): value is FieldDescriptor {
  if (!isPlainObject(value)) {
    return false;
  }

  return (
    isComponentDescriptor(value.__ecstatic_component) && typeof value.__ecstatic_field === "string"
  );
}

// ---------------------------------------------------------------------------
// Type definitions
// ---------------------------------------------------------------------------

/** Runtime descriptor produced by component() / components(). */
export interface ComponentDescriptor {
  readonly __ecstatic_name: string;
  readonly __ecstatic_fields: string[];
  readonly __ecstatic_defaults: Record<string, unknown>;
  readonly __ecstatic_default_values: unknown[];
  readonly __ecstatic_is_reference: (boolean | undefined)[];
  readonly __ecstatic_component_key: string;
  readonly __ecstatic_column_ctor?: (NumericColumnCtor | undefined)[];
}

/** A single component field. The phantom V carries the field's value type. */
export interface FieldDescriptor<V = unknown> {
  readonly __ecstatic_component: ComponentDescriptor;
  readonly __ecstatic_field: string;
  readonly __ecstatic_field_type?: V;
}

/** Covariant in T so RefMarker<Specific> extends RefMarker<General>. */
export interface RefMarker<out T = unknown> extends ComponentDescriptor {
  readonly __ecstatic_ref_marker?: T;
}

/** Allowed field default values: scalars, ref markers, and width markers. */
export type FieldDefault = number | string | boolean | RefMarker | WidthMarker;

/** Map a declared field default to the field's value type (literals widened). */
type InferFieldValue<D> =
  D extends RefMarker<infer R>
    ? R | undefined
    : D extends WidthMarker
      ? number
      : D extends boolean
        ? boolean
        : D extends number
          ? number
          : D extends string
            ? string
            : D;

/** Map a defaults record to the record of field value types. */
export type InferFields<T> = { [K in keyof T]: InferFieldValue<T[K]> };

/** Extract the value type carried by a field descriptor. */
export type FieldValue<D> = D extends FieldDescriptor<infer V> ? V : never;

/**
 * Fields value record of a component. Falls back to `Record<string, unknown>`
 * for untyped `ComponentDescriptor` values (internal code paths).
 */
export type ComponentFields<C> = C extends {
  readonly __ecstatic_component_meta?: { name: string; fields: infer F extends object };
}
  ? F
  : Record<string, unknown>;

/** Literal name of a component (plain `string` for untyped descriptors). */
export type ComponentName<C> = C extends { readonly __ecstatic_name: infer N extends string }
  ? N
  : string;

/**
 * A declared component: the runtime descriptor plus one typed field
 * descriptor per field. T holds field *value* types (refs already
 * unwrapped to `R | undefined`, width-marked fields as `number`).
 */
export type Component<
  N extends string = string,
  T extends object = object,
> = ComponentDescriptor & {
  readonly __ecstatic_name: N;
  readonly __ecstatic_descriptor_brand: true;
  readonly __ecstatic_component_meta?: { name: N; fields: T };
} & {
  readonly [K in keyof T]: FieldDescriptor<T[K]>;
};

/** A declared zero-field component (marker). */
export type Tag<N extends string = string> = ComponentDescriptor & {
  readonly __ecstatic_name: N;
  readonly __ecstatic_descriptor_brand: true;
  readonly __ecstatic_component_meta?: { name: N; fields: Record<string, never> };
};
