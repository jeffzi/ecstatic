/**
 * Component system: define components with typed fields and defaults.
 * Module-level name registry returns existing descriptors for equal shapes
 * and throws on shape conflicts.
 * Fields are validated against the pattern ^[A-Za-z_][A-Za-z0-9_]*$.
 * Field order is deterministic (byte-order sorted).
 * Reference fields hold entity IDs and are unwrapped in APIs.
 * Width markers (f32, i32, etc.) select TypedArray constructors for storage.
 */

import { structurallyEqual } from "./structural-equality.js";

/** Module-level name registry: name → descriptor. Returns existing on equal shape, throws on conflict. */
const seenNames = new Map<string, Record<string, unknown>>();

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

/**
 * Shape check for WidthMarker, the object a width constructor returns.
 *
 * @param v - Candidate field default. Only the two marker keys are checked; the sentinel
 *   behind `__ecstatic_width_marker` is not verified here.
 * @returns Whether `v` is an object carrying a `__ecstatic_width_marker` key and a numeric `value`.
 */
function isWidthMarker(v: unknown): v is WidthMarker {
  return (
    v !== null &&
    typeof v === "object" &&
    "__ecstatic_width_marker" in v &&
    "value" in v &&
    typeof v.value === "number"
  );
}

/**
 * Wrap a numeric default to use Float32Array storage in SoA columns.
 *
 * @param value - Default every spawned entity starts with. Kept as written, with no range or
 *   precision check; the Float32Array column coerces it on write.
 * @returns A fresh marker object; `component()` unwraps it to `value` and records the column width.
 */
export function f32(value: number): WidthMarker {
  return { __ecstatic_width_marker: F32_MARKER, value };
}

/**
 * Wrap a numeric default to use Float64Array storage in SoA columns.
 *
 * @param value - Default every spawned entity starts with. Kept as written, with no range or
 *   precision check; the Float64Array column coerces it on write.
 * @returns A fresh marker object; `component()` unwraps it to `value` and records the column width.
 */
export function f64(value: number): WidthMarker {
  return { __ecstatic_width_marker: F64_MARKER, value };
}

/**
 * Wrap a numeric default to use Int32Array storage in SoA columns.
 *
 * @param value - Default every spawned entity starts with. Kept as written, with no range or
 *   precision check; the Int32Array column coerces it on write.
 * @returns A fresh marker object; `component()` unwraps it to `value` and records the column width.
 */
export function i32(value: number): WidthMarker {
  return { __ecstatic_width_marker: I32_MARKER, value };
}

/**
 * Wrap a numeric default to use Int16Array storage in SoA columns.
 *
 * @param value - Default every spawned entity starts with. Kept as written, with no range or
 *   precision check; the Int16Array column coerces it on write.
 * @returns A fresh marker object; `component()` unwraps it to `value` and records the column width.
 */
export function i16(value: number): WidthMarker {
  return { __ecstatic_width_marker: I16_MARKER, value };
}

/**
 * Wrap a numeric default to use Int8Array storage in SoA columns.
 *
 * @param value - Default every spawned entity starts with. Kept as written, with no range or
 *   precision check; the Int8Array column coerces it on write.
 * @returns A fresh marker object; `component()` unwraps it to `value` and records the column width.
 */
export function i8(value: number): WidthMarker {
  return { __ecstatic_width_marker: I8_MARKER, value };
}

/**
 * Wrap a numeric default to use Uint32Array storage in SoA columns.
 *
 * @param value - Default every spawned entity starts with. Kept as written, with no range or
 *   precision check; the Uint32Array column coerces it on write.
 * @returns A fresh marker object; `component()` unwraps it to `value` and records the column width.
 */
export function u32(value: number): WidthMarker {
  return { __ecstatic_width_marker: U32_MARKER, value };
}

/**
 * Wrap a numeric default to use Uint16Array storage in SoA columns.
 *
 * @param value - Default every spawned entity starts with. Kept as written, with no range or
 *   precision check; the Uint16Array column coerces it on write.
 * @returns A fresh marker object; `component()` unwraps it to `value` and records the column width.
 */
export function u16(value: number): WidthMarker {
  return { __ecstatic_width_marker: U16_MARKER, value };
}

/**
 * Wrap a numeric default to use Uint8Array storage in SoA columns.
 *
 * @param value - Default every spawned entity starts with. Kept as written, with no range or
 *   precision check; the Uint8Array column coerces it on write.
 * @returns A fresh marker object; `component()` unwraps it to `value` and records the column width.
 */
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

/**
 * Map a width sentinel to the TypedArray constructor of its column.
 *
 * @param marker - Sentinel read from a WidthMarker's `__ecstatic_width_marker` key.
 * @returns The constructor the world instantiates for that field's column; the same constructor
 *   reference on every call.
 * @throws If the sentinel is none of the eight module symbols. Only a forged marker object reaches
 *   this, since `isWidthMarker` does not verify the sentinel.
 */
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

/**
 * Select the default TypedArray column constructor for an unmarked scalar default.
 *
 * @param value - Field default that is neither a ref marker nor a width marker.
 * @returns `Float64Array` for numbers, `Uint8Array` for booleans, or `undefined` for strings,
 *   arrays, and anything else, meaning the column is a plain array.
 */
function defaultColumnCtor(value: unknown): NumericColumnCtor | undefined {
  if (typeof value === "number") {
    return Float64Array;
  }
  if (typeof value === "boolean") {
    return Uint8Array;
  }
  return undefined;
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
 * @throws If `fieldName` is not a string.
 * @throws If `fieldName` does not match the ASCII identifier pattern.
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

/**
 * Narrow a value to a record for field-default and descriptor checks.
 *
 * @param v - Any value.
 * @returns Whether `v` is a non-null object that is not an array, `Date`, `Map`, or `Set`.
 *   Instances of other classes pass.
 */
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

/**
 * Check a raw `fields` argument before it is turned into a descriptor.
 *
 * @param componentName - Component being declared; used in error messages only.
 * @param fields - Raw value from the caller, before any typing.
 * @returns The same `fields` object, not a copy, narrowed to a record.
 * @throws If `fields` is not a plain object.
 * @throws Whatever {@link validateFieldName} throws for a key that is not an ASCII identifier.
 */
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

/** Normalized per-field storage plan produced by classifyFieldDefault. */
interface FieldPlan {
  readonly value: unknown;
  readonly isReference: boolean;
  readonly columnCtor: NumericColumnCtor | undefined;
}

/**
 * Normalize a single field default into its per-field storage plan.
 *
 * @param defaultValue - Raw default as written in the declaration: a scalar, an array, a `ref()`
 *   marker, or a width marker.
 * @returns A fresh plan. A ref marker yields `value: undefined` and no column constructor; a width
 *   marker yields the wrapped number and the TypedArray it selects; any other value is kept as-is
 *   with the constructor {@link defaultColumnCtor} picks.
 * @throws If `defaultValue` is a non-array object other than a marker: object defaults are not
 *   supported, the field has to be declared with `ref<T>()` and initialized per entity.
 * @throws Whatever {@link getColumnCtorForMarker} throws for a forged width marker.
 */
function classifyFieldDefault(defaultValue: unknown): FieldPlan {
  if (defaultValue === REF_SENTINEL) {
    return { value: undefined, isReference: true, columnCtor: undefined };
  }

  if (isWidthMarker(defaultValue)) {
    return {
      value: defaultValue.value,
      isReference: false,
      columnCtor: getColumnCtorForMarker(defaultValue.__ecstatic_width_marker),
    };
  }

  if (typeof defaultValue === "object" && defaultValue !== null && !Array.isArray(defaultValue)) {
    throw new Error(
      "ecstatic: object defaults are not supported; declare the field with ref<T>() and initialize it explicitly",
    );
  }

  // Scalar default (number, string, boolean, array)
  return { value: defaultValue, isReference: false, columnCtor: defaultColumnCtor(defaultValue) };
}

/**
 * Build an unregistered descriptor from validated defaults.
 *
 * @param name - Component name; also the tail of `__ecstatic_component_key`, which is
 *   `"<length>:<name>"`.
 * @param defaults - Field defaults already checked by {@link validateFields}; field names are not
 *   re-validated here. Declaration order is irrelevant, fields are sorted by UTF-16 code unit.
 * @returns A fresh descriptor that is not in the registry; the caller decides whether to keep it
 *   ({@link resolveExisting} discards it after comparing shapes).
 * @throws Whatever {@link classifyFieldDefault} throws for an unsupported default.
 */
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

  const normalizedDefaults: Record<string, unknown> = {};

  for (const fieldName of fields) {
    const plan = classifyFieldDefault(defaults[fieldName]);
    defaultValues.push(plan.value);
    isReference.push(plan.isReference);
    columnCtors.push(plan.columnCtor);
    normalizedDefaults[fieldName] = plan.value;
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
 *
 * @typeParam T - Value type the field unwraps to; phantom only, never checked at runtime.
 * @returns The single module-level sentinel, identical across calls. `component()` recognizes it
 *   by identity, so a copy (spread or clone) is rejected as an object default.
 */
export function ref<T = unknown>(): RefMarker<T> {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- branded type boundary
  return REF_SENTINEL as unknown as RefMarker<T>;
}

/** Descriptor keys whose arrays define component shape for idempotent registration. */
const SHAPE_ARRAY_KEYS = [
  "__ecstatic_fields",
  "__ecstatic_default_values",
  "__ecstatic_is_reference",
  "__ecstatic_column_ctor",
] as const;

function arraysIdentical(a: unknown[], b: unknown[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function shapeArraysMatch(
  existing: Record<string, unknown>,
  incoming: Record<string, unknown>,
): boolean {
  for (const key of SHAPE_ARRAY_KEYS) {
    const a = existing[key];
    const b = incoming[key];
    if (!Array.isArray(a) || !Array.isArray(b)) {
      if (a !== b) return false;
      continue;
    }
    const equal =
      key === "__ecstatic_default_values" ? structurallyEqual(a, b) : arraysIdentical(a, b);
    if (!equal) return false;
  }
  return true;
}

function relationMetadataMatch(
  existing: Record<string, unknown>,
  options?: CreateDescriptorOptions,
): boolean {
  const existingIsRelation = existing["isRelation"] === true;
  const incomingIsRelation = options?.isRelation === true;
  if (existingIsRelation !== incomingIsRelation) return false;
  if (!existingIsRelation) return true;
  const existingConstraints = existing["constraints"];
  const incomingConstraints = options?.constraints ?? [];
  if (!Array.isArray(existingConstraints)) return false;
  return arraysIdentical(existingConstraints, incomingConstraints);
}

/**
 * Decide whether a re-declaration may reuse an already registered descriptor.
 *
 * @param existing - Descriptor currently in the registry.
 * @param incoming - Throwaway descriptor built from the new declaration.
 * @param options - Relation metadata of the new declaration; `undefined` means a plain component.
 * @returns Whether field names, default values, reference flags, column constructors, relation
 *   flag, and constraints all match element-wise. Default values compare by content through
 *   {@link structurallyEqual}, so a fresh but equal array literal matches; everything else,
 *   constraints included, compares by `===`.
 */
function shapesEqual(
  existing: Record<string, unknown>,
  incoming: Record<string, unknown>,
  options?: CreateDescriptorOptions,
): boolean {
  return shapeArraysMatch(existing, incoming) && relationMetadataMatch(existing, options);
}

/** Relation metadata passed to createDescriptor for shape comparison. */
export interface CreateDescriptorOptions {
  readonly isRelation?: true;
  readonly constraints?: ComponentDescriptor[];
}

/**
 * Look up `name` in the idempotent registry.
 *
 * @param name - Component name to look up.
 * @param defaults - Validated field defaults of the new declaration; a throwaway descriptor is
 *   built from them for the shape comparison.
 * @param options - Relation metadata of the new declaration; `undefined` means a plain component.
 * @returns The registered descriptor when its shape matches, or `undefined` when the name is
 *   unregistered. The registry is never modified.
 * @throws If the name is registered with a different shape.
 * @throws Whatever {@link descriptorFromDefaults} throws for an unsupported default; only reached
 *   when the name is already registered.
 */
function resolveExisting(
  name: string,
  defaults: Record<string, unknown>,
  options?: CreateDescriptorOptions,
): Record<string, unknown> | undefined {
  const existing = seenNames.get(name);
  if (existing === undefined) {
    return undefined;
  }

  const incoming = descriptorFromDefaults(name, defaults);
  if (!shapesEqual(existing, incoming, options)) {
    throw new Error(`component shape conflict: ${name}`);
  }
  return existing;
}

/**
 * Shared descriptor-construction path for component() and relation().
 *
 * @param name - Registry key; any string is accepted, it is not validated.
 * @param rawFields - Field defaults as passed by the caller; validated here.
 * @param options - Present for relations only. `isRelation` and `constraints` are copied onto a
 *   newly built descriptor and compared against an already registered one.
 * @returns The registered descriptor for `name`: the existing one on an equal-shape
 *   re-declaration, otherwise the newly built one, registered before it is returned.
 * @throws Whatever {@link validateFields} throws for a malformed `rawFields`.
 * @throws Whatever {@link resolveExisting} throws for a shape conflict.
 * @throws Whatever {@link descriptorFromDefaults} throws for an unsupported default.
 */
export function createDescriptor(
  name: string,
  rawFields: unknown,
  options?: CreateDescriptorOptions,
): Record<string, unknown> {
  const defaults = validateFields(name, rawFields);

  const existing = resolveExisting(name, defaults, options);
  if (existing !== undefined) {
    return existing;
  }

  const descriptor = descriptorFromDefaults(name, defaults);

  if (options?.isRelation === true) {
    descriptor["isRelation"] = true;
    descriptor["constraints"] = options.constraints ?? [];
  }

  seenNames.set(name, descriptor);
  return descriptor;
}

/**
 * Register a tag: a zero-field component used as a marker.
 *
 * @typeParam N - Literal component name.
 * @param name - Registry key, unique per process; the same name declared from several modules
 *   yields one shared descriptor.
 * @returns The registered tag descriptor, shared by every caller that declares this name.
 * @throws If `name` is already registered with a different shape (fields or relation metadata).
 */
export function component<N extends string>(name: N): Tag<N>;
/**
 * Register a component from a name and its field defaults.
 *
 * @typeParam N - Literal component name.
 * @typeParam T - Declared defaults; each value type is mapped through {@link InferFieldValue}.
 * @param name - Registry key, unique per process; the same name declared from several modules
 *   yields one shared descriptor.
 * @param fields - Default per field: a scalar, `ref()`, or a width marker. Names must be ASCII
 *   identifiers; declaration order does not matter, fields are sorted by UTF-16 code unit. An
 *   empty object declares a tag.
 * @returns The registered descriptor with one typed field descriptor per field, shared by every
 *   caller that declares this name.
 * @throws If a field name is not an ASCII identifier, a default is an object other than a marker,
 *   or `name` is already registered with a different shape.
 */
export function component<N extends string, T extends Record<string, FieldDefault>>(
  name: N,
  fields: T,
): keyof T extends never ? Tag<N> : Component<N, { [K in keyof T]: InferFieldValue<T[K]> }>;
export function component(name: string, fields?: Record<string, unknown>): unknown {
  return createDescriptor(name, fields ?? {});
}

/**
 * Register multiple component types from a single name-keyed declaration object.
 *
 * Validation is atomic: every entry is checked before any new name is registered, so a throw
 * leaves the registry untouched.
 *
 * @typeParam T - Declaration object; keys become component names, values their field defaults.
 * @param defs - Name to field defaults. An empty defaults object declares a tag.
 * @returns A fresh object with the same keys mapping to registered descriptors; a name already
 *   registered with equal shape maps to the existing descriptor rather than a new one.
 * @throws If any field name is not an ASCII identifier, any default is an object other than a
 *   marker, or any name is already registered with a different shape.
 */
export function components<T extends Record<string, Record<string, FieldDefault>>>(
  defs: T,
): {
  [K in keyof T]: keyof T[K] extends never
    ? Tag<K & string>
    : Component<K & string, { [F in keyof T[K]]: InferFieldValue<T[K][F]> }>;
} {
  const result: Record<string, unknown> = {};
  const newDescriptors = new Map<string, Record<string, unknown>>();

  // Validate all components before registering any names (atomic).
  // Already-registered names with equal shape resolve to the existing descriptor;
  // shape conflicts throw before any new name is registered.
  for (const name in defs) {
    const defaults = validateFields(name, defs[name]);
    const existing = resolveExisting(name, defaults);

    if (existing !== undefined) {
      result[name] = existing;
    } else {
      newDescriptors.set(name, descriptorFromDefaults(name, defaults));
    }
  }

  for (const [name, descriptor] of newDescriptors) {
    seenNames.set(name, descriptor);
    result[name] = descriptor;
  }

  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- opaque type return
  return result as unknown as {
    [K in keyof T]: keyof T[K] extends never
      ? Tag<K & string>
      : Component<K & string, { [F in keyof T[K]]: InferFieldValue<T[K][F]> }>;
  };
}

/**
 * Duck-type predicate for ComponentDescriptor.
 *
 * @param value - Any value, typically an unknown argument at a public API boundary.
 * @returns Whether `value` is a plain object with the name, fields, default-values, and
 *   reference-flags keys. Array element types are not checked, and the optional
 *   `__ecstatic_column_ctor` is not required.
 */
export function isComponentDescriptor(value: unknown): value is ComponentDescriptor {
  if (!isPlainObject(value)) {
    return false;
  }

  return (
    typeof value["__ecstatic_name"] === "string" &&
    Array.isArray(value["__ecstatic_fields"]) &&
    Array.isArray(value["__ecstatic_default_values"]) &&
    Array.isArray(value["__ecstatic_is_reference"])
  );
}

/**
 * Duck-type predicate for FieldDescriptor.
 *
 * @param value - Any value, typically an accessor or query argument that may be a field or a
 *   whole component.
 * @returns Whether `value` is a plain object whose `__ecstatic_component` passes
 *   {@link isComponentDescriptor} and whose `__ecstatic_field` is a string. The field is not
 *   checked against that component's field list.
 */
export function isFieldDescriptor(value: unknown): value is FieldDescriptor {
  if (!isPlainObject(value)) {
    return false;
  }

  return (
    isComponentDescriptor(value["__ecstatic_component"]) &&
    typeof value["__ecstatic_field"] === "string"
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

/**
 * Map a declared field default to the field's value type (literals widened).
 *
 * Public signatures apply this field-by-field with an inline mapped type
 * instead of a named `InferFields<T>` alias: TypeScript preserves alias names
 * in hover display, so a named alias would surface as `InferFields<{...}>` in
 * every editor tooltip instead of the resolved `{ x: number; y: number }`.
 */
export type InferFieldValue<D> =
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
