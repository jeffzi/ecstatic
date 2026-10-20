/**
 * Resource system: world-scoped singletons.
 *
 * A resource declares a named field group with defaults; each world holds at
 * most one data record per resource, lazily initialized from those defaults on
 * first access. Resources live in their own module-level name registry,
 * separate from the component namespace.
 *
 * Records, arrays, `Date`s, `Map`s, and `Set`s in the defaults are deep-cloned
 * per world, so two worlds never alias the registered defaults or each other's
 * data. Class instances and functions are shared by reference.
 *
 * Registration is idempotent: re-declaring a name with structurally equal
 * defaults returns the existing ID; a different shape throws.
 */

import { validateFieldName } from "./component.js";
import { isPlainRecord, structurallyEqual } from "./structural-equality.js";
import type { World } from "./world.js";

/**
 * Registry entry per resource: `fields` is the sorted field-name list, and
 * `defaults` is the deep-cloned snapshot worlds initialize from.
 */
export interface ResourceMeta {
  readonly name: string;
  readonly fields: string[];
  readonly defaults: Record<string, unknown>;
}

/**
 * A world-scoped singleton ID. Branded so raw numbers are rejected.
 *
 * @typeParam N - Literal resource name.
 * @typeParam T - Shape of the resource's fields.
 */
export type Resource<N extends string = string, T extends object = object> = number & {
  readonly __ecstatic_resource_meta: { name: N; fields: T };
};

/** Field-value shape (the `T` brand) of a resource ID; `never` when `R` is not a `Resource`. */
export type ResourceFields<R> = R extends Resource<string, infer T> ? T : never;

let nextResourceId = 0;
const resourceRegistry = new Map<number, ResourceMeta>();
const resourceNames = new Map<string, number>();

/**
 * Recursively copies records, arrays, `Date`s, `Map`s, and `Set`s.
 *
 * Every other value — primitives, functions, and class instances — is returned
 * as-is: a resource field holding one of those is shared between worlds, since
 * copying it would need semantics only its owner knows. `Map` keys and `Set`
 * members are likewise kept by reference, so identity-based membership survives
 * the copy; only the containers themselves and their values are fresh.
 *
 * @param value - Any value, including `null` and `undefined`; containers are copied, everything else is shared.
 * @returns A fresh container when `value` is one of the copied kinds, otherwise `value` itself.
 */
function cloneUnknown(value: unknown): unknown {
  if (typeof value !== "object" || value === null) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(cloneUnknown);
  }
  if (value instanceof Date) {
    return new Date(value.getTime());
  }
  if (value instanceof Map) {
    const copy = new Map<unknown, unknown>();
    for (const [key, nested] of value) {
      copy.set(key, cloneUnknown(nested));
    }
    return copy;
  }
  if (value instanceof Set) {
    return new Set(value);
  }
  if (!isPlainRecord(value)) {
    return value;
  }
  const copy: Record<string, unknown> = {};
  for (const key in value) {
    copy[key] = cloneUnknown(value[key]);
  }
  return copy;
}

/**
 * Deep copy of a resource field value. See `cloneUnknown` for what is copied and what is shared.
 *
 * @param value - Field value to copy; its declared type is preserved because the copy mirrors the input's shape.
 * @returns The copy, typed as the input so it can be stored or returned in its place.
 */
function cloneValue<T>(value: T): T {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the clone preserves the input's shape
  return cloneUnknown(value) as T;
}

/**
 * Registers a new resource type.
 *
 * Re-declaring an already-registered name is idempotent: if `defaults` is
 * structurally equal to the existing registration, the existing ID is
 * returned.
 *
 * @param name - Registry key, unique across resources but independent of the component namespace.
 * @param defaults - Initial field values. Field names must be ASCII identifiers, the same rule
 *   `component()` applies. The object is deep-copied here, so mutating it afterwards cannot reach
 *   any world: the registered snapshot is what worlds initialize from. See `cloneUnknown` for
 *   which values are copied and which are shared.
 * @returns The numeric ID, branded with `name` and the field shape; a structurally equal
 *   re-declaration returns the same ID.
 *
 * @throws If a key of `defaults` is not an ASCII identifier (`^[A-Za-z_][A-Za-z0-9_]*$`)
 * @throws If `name` is already registered with structurally different defaults
 */
export function resource<N extends string, T extends object>(name: N, defaults: T): Resource<N, T> {
  const existingId = resourceNames.get(name);
  if (existingId !== undefined) {
    const existing = getResourceMeta(existingId);
    if (!structurallyEqual(defaults, existing.defaults)) {
      throw new Error(`resource shape conflict: ${name}`);
    }
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- branded type boundary
    return existingId as Resource<N, T>;
  }

  const defaultsRecord: Record<string, unknown> = {};
  // Object.entries widens the declared shape to an indexable record without a cast
  for (const [field, value] of Object.entries(defaults)) {
    validateFieldName("resource", name, field);
    defaultsRecord[field] = cloneValue(value);
  }

  const id = nextResourceId;
  nextResourceId = id + 1;

  // Sort field names for deterministic byte-order ordering (not locale-dependent)
  // oxlint-disable-next-line unicorn/no-array-sort -- in-place sort of a fresh array; toSorted() would copy for no reason
  const fields = Object.keys(defaultsRecord).sort();

  resourceRegistry.set(id, { name, fields, defaults: defaultsRecord });
  resourceNames.set(name, id);

  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- branded type boundary
  return id as Resource<N, T>;
}

/**
 * Registry lookup for a resource ID.
 *
 * @param id - Resource ID as returned by `resource()`; typed as a raw number so internal callers
 *   can pass map keys without a brand.
 * @returns The live registry entry — the same object on every call, not a copy, so callers must
 *   not mutate it.
 *
 * @throws If `id` was never returned by `resource()`
 */
export function getResourceMeta(id: number): ResourceMeta {
  const meta = resourceRegistry.get(id);
  if (meta === undefined) {
    throw new Error(`unknown resource ID: ${id}`);
  }
  return meta;
}

/**
 * Overwrites every declared field of `data` with a fresh clone of its registered default.
 *
 * @param data - A world's live resource record, mutated in place so references handed out by
 *   `getResource` stay valid.
 * @param meta - Registry entry whose `fields` list drives the write; keys of `data` outside that
 *   list are left alone.
 *
 * @throws If `meta.fields` contains a hole — an invariant violation the registry never produces
 */
function fillFromDefaults(data: Record<string, unknown>, meta: ResourceMeta): void {
  const fields = meta.fields;
  const defaults = meta.defaults;
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i];
    /* istanbul ignore next */
    if (field === undefined) throw new Error("invariant: field index out of bounds");
    data[field] = cloneValue(defaults[field]);
  }
}

/**
 * Creates a resource's data record from its registered defaults and stores it.
 *
 * Callers own the fast path: every one of them looks the resource up first, so
 * this runs only when the world has no record for `resId` yet.
 *
 * @param world - World whose `resources` map receives the record; a record already stored for
 *   `resId` would be replaced, which is why callers check first.
 * @param resId - Resource ID to initialize.
 * @returns The record just stored, the same reference `world.resources` now holds.
 *
 * @throws If `resId` is not a registered resource ID
 */
function initResource(world: World, resId: number): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  fillFromDefaults(data, getResourceMeta(resId));
  world.resources.set(resId, data);
  return data;
}

/**
 * Reads a world's resource record, lazy-initializing it from defaults on first access.
 *
 * @param world - World that owns the record; each world has its own, never shared with another.
 * @param res - Resource ID from `resource()`; its brand types the returned fields.
 * @returns The live record — the same object on every call for this world, so writes through it
 *   are visible to the next read without `setResource`.
 *
 * @throws If `res` is not a registered resource ID
 */
export function getResource<R extends Resource>(world: World, res: R): ResourceFields<R> {
  const data = world.resources.get(res) ?? initResource(world, res);
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- data record matches the resource's declared fields
  return data as ResourceFields<R>;
}

/**
 * Partial-merges values into a resource. Lazy-initializes if not yet accessed.
 *
 * @param world - World whose record is written; other worlds holding the same resource are unaffected.
 * @param res - Resource ID from `resource()`.
 * @param values - Fields to overwrite. Only own keys are written, and a key set to `undefined` is
 *   skipped rather than clearing the field; each value is deep-cloned (see `cloneUnknown`), so
 *   later mutation of `values` does not reach the record.
 *
 * @throws If `res` is not a registered resource ID
 */
export function setResource<R extends Resource>(
  world: World,
  res: R,
  values: Partial<ResourceFields<R>>,
): void {
  const data = world.resources.get(res) ?? initResource(world, res);
  for (const key in values) {
    // Only the value object's own keys are written — an enumerable property
    // inherited from its prototype is not part of the write set. An
    // explicitly-undefined entry leaves the field untouched (same contract as
    // writeFieldOverrides); exactOptionalPropertyTypes already rejects it at
    // compile time, so this only guards untyped callers.
    if (Object.hasOwn(values, key) && values[key] !== undefined) {
      data[key] = cloneValue(values[key]);
    }
  }
}

/**
 * Restores all fields of a resource to its registered defaults.
 *
 * If the resource has never been accessed, this is equivalent to the first
 * `getResource` call: the record is created and populated from defaults.
 *
 * If the resource has been accessed before, the existing live record is reused
 * (no new allocation) and each field is overwritten with a fresh clone of the
 * registered default, so `getResource` returns the same reference before and
 * after the reset. Object-typed defaults are deep-cloned, so resetting two
 * worlds with the same resource does not alias their data.
 *
 * @param world - World whose record is reset; other worlds keep their data.
 * @param res - Resource ID from `resource()`.
 *
 * @throws If `res` is not a registered resource ID
 */
export function resetResource(world: World, res: Resource): void {
  const data = world.resources.get(res);
  if (data === undefined) {
    initResource(world, res);
    return;
  }
  fillFromDefaults(data, getResourceMeta(res));
}
