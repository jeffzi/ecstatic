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

interface WidthMarker {
  readonly __ecstatic_width_marker: WidthMarkerType;
  readonly value: number;
}

/** Validate that a value is a width marker object */
function isWidthMarker(v: unknown): v is WidthMarker {
  return (
    v !== null &&
    typeof v === "object" &&
    "__ecstatic_width_marker" in v &&
    typeof (v as Record<string, unknown>).value === "number"
  );
}

/** Public width marker constructors */
export function f32(value: number): WidthMarker {
  return { __ecstatic_width_marker: F32_MARKER, value };
}

export function f64(value: number): WidthMarker {
  return { __ecstatic_width_marker: F64_MARKER, value };
}

export function i32(value: number): WidthMarker {
  return { __ecstatic_width_marker: I32_MARKER, value };
}

export function i16(value: number): WidthMarker {
  return { __ecstatic_width_marker: I16_MARKER, value };
}

export function i8(value: number): WidthMarker {
  return { __ecstatic_width_marker: I8_MARKER, value };
}

export function u32(value: number): WidthMarker {
  return { __ecstatic_width_marker: U32_MARKER, value };
}

export function u16(value: number): WidthMarker {
  return { __ecstatic_width_marker: U16_MARKER, value };
}

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

/** Get TypedArray constructor for a width marker */
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
  }
}

/** Validate field names against ^[A-Za-z_][A-Za-z0-9_]*$ */
function validateFieldName(componentName: string, fieldName: unknown): asserts fieldName is string {
  if (typeof fieldName !== "string") {
    throw new Error(`component field names must be strings: ${componentName}`);
  }

  const nameRegex = /^[A-Za-z_][A-Za-z0-9_]*$/;
  if (!nameRegex.test(fieldName)) {
    throw new Error(
      `component field name must be a valid ASCII identifier (^[A-Za-z_][A-Za-z0-9_]*$): ${componentName}.${fieldName}`,
    );
  }
}

/** Validate and normalize field defaults */
function validateFields(componentName: string, fields: unknown): Record<string, unknown> {
  if (
    typeof fields !== "object" ||
    fields === null ||
    Array.isArray(fields) ||
    fields instanceof Date ||
    fields instanceof Map ||
    fields instanceof Set
  ) {
    throw new Error(`component fields must be a table: ${componentName}`);
  }

  const defaults = fields as Record<string, unknown>;
  for (const fieldName in defaults) {
    validateFieldName(componentName, fieldName);
  }

  return defaults;
}

/** Check if a name is already registered */
function assertNameAvailable(name: string): void {
  if (seenNames.has(name)) {
    throw new Error(`component name already registered: ${name}`);
  }
}

/** Create a descriptor from validated defaults */
function descriptorFromDefaults(
  name: string,
  defaults: Record<string, unknown>,
): Record<string, unknown> {
  // Sort fields by byte order (ASCII byte values, not locale-dependent)
  // JavaScript's default string sort is byte-order (UTF-16 code unit order)
  const fields = Object.keys(defaults).sort();

  // Build parallel arrays for defaults, references, and column constructors
  const defaultValues: unknown[] = [];
  const isReference: (boolean | undefined)[] = [];
  const columnCtors: (
    | typeof Float64Array
    | typeof Float32Array
    | typeof Int32Array
    | typeof Int16Array
    | typeof Int8Array
    | typeof Uint32Array
    | typeof Uint16Array
    | typeof Uint8Array
    | undefined
  )[] = [];

  // Normalize defaults: extract values from width markers
  const normalizedDefaults: Record<string, unknown> = {};

  for (const fieldName of fields) {
    const defaultValue = defaults[fieldName];

    if (defaultValue === REF_SENTINEL) {
      // Reference field: no default value (undefined), marked as reference
      defaultValues.push(undefined);
      isReference.push(true);
      columnCtors.push(undefined);
      normalizedDefaults[fieldName] = undefined;
    } else if (isWidthMarker(defaultValue)) {
      // Width-marked numeric default: extract the value, store the column constructor
      defaultValues.push(defaultValue.value);
      isReference.push(false);
      columnCtors.push(getColumnCtorForMarker(defaultValue.__ecstatic_width_marker));
      normalizedDefaults[fieldName] = defaultValue.value;
    } else if (
      typeof defaultValue === "object" &&
      defaultValue !== null &&
      !Array.isArray(defaultValue)
    ) {
      // Table defaults are not supported; only ref() fields can hold tables
      throw new Error(
        "ecstatic: table defaults are not supported; declare the field with ref<T>() and initialize it explicitly",
      );
    } else {
      // Scalar default (number, string, boolean, array)
      defaultValues.push(defaultValue);
      isReference.push(false);
      columnCtors.push(
        typeof defaultValue === "number"
          ? Float64Array // default numeric type is Float64
          : typeof defaultValue === "boolean"
            ? Uint8Array // boolean uses Uint8
            : undefined, // strings and others use plain arrays
      );
      normalizedDefaults[fieldName] = defaultValue;
    }
  }

  // Build the descriptor object
  const descriptor: Record<string, unknown> = {
    __ecstatic_name: name,
    __ecstatic_fields: fields,
    __ecstatic_defaults: normalizedDefaults,
    __ecstatic_default_values: defaultValues,
    __ecstatic_is_reference: isReference,
    __ecstatic_component_key: `${name.length}:${name}`,
    __ecstatic_column_ctor: columnCtors,
  };

  // Add per-field properties
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
  return REF_SENTINEL as unknown as RefMarker<T>;
}

/**
 * Register a single component descriptor from a name and optional field defaults.
 * If fields is omitted, the result is a tag (0-field component).
 */
export function component<N extends string>(name: N): Tag<N>;
export function component<N extends string, T extends Record<string, unknown>>(
  name: N,
  fields: T,
): Component<N, T>;
export function component(name: string, fields?: Record<string, unknown>): unknown {
  assertNameAvailable(name);
  const defaults = validateFields(name, fields ?? {});
  seenNames.add(name);
  return descriptorFromDefaults(name, defaults);
}

/**
 * Register multiple component types from a single name-keyed declaration object.
 * Validates all components before registering any names (atomic validation).
 */
export function components<T extends Record<string, Record<string, unknown>>>(
  defs: T,
): {
  [K in keyof T]: keyof T[K] extends never ? Tag<K & string> : Component<K & string, T[K]>;
} {
  const result: Record<string, unknown> = {};
  const defaultsByName = new Map<string, Record<string, unknown>>();

  // Validate all components before registering any names (atomic)
  for (const name in defs) {
    assertNameAvailable(name);
    defaultsByName.set(name, validateFields(name, defs[name]));
  }

  // Register and create descriptors
  for (const [name, defaults] of defaultsByName) {
    seenNames.add(name);
    result[name] = descriptorFromDefaults(name, defaults);
  }

  return result as unknown as {
    [K in keyof T]: keyof T[K] extends never ? Tag<K & string> : Component<K & string, T[K]>;
  };
}

/** Duck-type predicate: check if value has the shape of a ComponentDescriptor */
export function isComponentDescriptor(value: unknown): value is ComponentDescriptor {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    value instanceof Date ||
    value instanceof Map ||
    value instanceof Set
  ) {
    return false;
  }

  const maybe = value as Record<string, unknown>;
  return (
    typeof maybe.__ecstatic_name === "string" &&
    Array.isArray(maybe.__ecstatic_fields) &&
    Array.isArray(maybe.__ecstatic_default_values) &&
    Array.isArray(maybe.__ecstatic_is_reference)
  );
}

/** Duck-type predicate: check if value has the shape of a FieldDescriptor */
export function isFieldDescriptor(value: unknown): value is FieldDescriptor {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    value instanceof Date ||
    value instanceof Map ||
    value instanceof Set
  ) {
    return false;
  }

  const maybe = value as Record<string, unknown>;
  return (
    isComponentDescriptor(maybe.__ecstatic_component) && typeof maybe.__ecstatic_field === "string"
  );
}

// --- Type definitions (used by type stubs, echoing _core.d.ts patterns) ---

export interface ComponentDescriptor {
  readonly __ecstatic_name: string;
  readonly __ecstatic_fields: string[];
  readonly __ecstatic_defaults: Record<string, unknown>;
  readonly __ecstatic_default_values: unknown[];
  readonly __ecstatic_is_reference: (boolean | undefined)[];
  readonly __ecstatic_component_key: string;
  readonly __ecstatic_column_ctor?: (NumericColumnCtor | undefined)[];
}

export interface FieldDescriptor {
  readonly __ecstatic_component: ComponentDescriptor;
  readonly __ecstatic_field: string;
}

/** Covariant in T so RefMarker<Specific> extends RefMarker<General>. */
export interface RefMarker<out T = unknown> extends ComponentDescriptor {
  readonly __ecstatic_ref_marker?: T;
}

export interface Component<N extends string = string, T extends object = object> {
  readonly __ecstatic_descriptor_brand: true;
  readonly __ecstatic_component_meta?: { name: N; fields: T };
}

export interface Tag<N extends string = string> {
  readonly __ecstatic_descriptor_brand: true;
  readonly __ecstatic_component_meta?: { name: N; fields: Record<string, never> };
}
