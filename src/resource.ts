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
 */

import type { World } from "./world.js";

/** Metadata stored for each registered resource type. */
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

/** Field value record of a resource. */
export type ResourceFields<R> = R extends Resource<string, infer T> ? T : never;

let nextResourceId = 0;
const resourceRegistry = new Map<number, ResourceMeta>();
const resourceNames = new Set<string>();

/** True for objects whose prototype is `Object.prototype` or `null` — i.e. records, not instances. */
function isPlainRecord(v: object): v is Record<string, unknown> {
  const proto: unknown = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/**
 * Recursively copies records, arrays, `Date`s, `Map`s, and `Set`s.
 *
 * Every other value — primitives, functions, and class instances — is returned
 * as-is: a resource field holding one of those is shared between worlds, since
 * copying it would need semantics only its owner knows. `Map` keys and `Set`
 * members are likewise kept by reference, so identity-based membership survives
 * the copy; only the containers themselves and their values are fresh.
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

/** Deep copy of a resource field value. See `cloneUnknown` for what is copied and what is shared. */
function cloneValue<T>(value: T): T {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the clone preserves the input's shape
  return cloneUnknown(value) as T;
}

/** Registers a new resource type and returns its numeric ID. */
export function resource<N extends string, T extends object>(name: N, defaults: T): Resource<N, T> {
  if (resourceNames.has(name)) {
    throw new Error(`resource name already registered: ${name}`);
  }

  const id = nextResourceId;
  nextResourceId = id + 1;

  // Object.entries widens the declared shape to an indexable record without a cast
  const defaultsRecord: Record<string, unknown> = Object.fromEntries(Object.entries(defaults));

  // Sort field names for deterministic byte-order ordering (not locale-dependent)
  // oxlint-disable-next-line unicorn/no-array-sort -- in-place sort of a fresh array; toSorted() would copy for no reason
  const fields = Object.keys(defaultsRecord).sort();

  resourceRegistry.set(id, { name, fields, defaults: defaultsRecord });
  resourceNames.add(name);

  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- branded type boundary
  return id as Resource<N, T>;
}

/** Returns the metadata for a registered resource ID. */
export function getResourceMeta(id: number): ResourceMeta {
  const meta = resourceRegistry.get(id);
  if (meta === undefined) {
    throw new Error(`unknown resource ID: ${id}`);
  }
  return meta;
}

/** Overwrites every declared field of `data` with a fresh clone of its registered default. */
function fillFromDefaults(data: Record<string, unknown>, meta: ResourceMeta): void {
  const fields = meta.fields;
  const defaults = meta.defaults;
  for (let i = 0; i < fields.length; i++) {
    const f = fields[i]!;
    data[f] = cloneValue(defaults[f]);
  }
}

/**
 * Creates a resource's data record from its registered defaults and stores it.
 *
 * Callers own the fast path: every one of them looks the resource up first, so
 * this runs only when the world has no record for `resId` yet.
 */
function initResource(world: World, resId: number): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  fillFromDefaults(data, getResourceMeta(resId));
  world.resources.set(resId, data);
  return data;
}

/** Gets a resource's data. Lazy-initializes from defaults on first access. */
export function getResource<R extends Resource>(world: World, res: R): ResourceFields<R> {
  const data = world.resources.get(res) ?? initResource(world, res);
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- data record matches the resource's declared fields
  return data as ResourceFields<R>;
}

/** Partial-merges values into a resource. Lazy-initializes if not yet accessed. */
export function setResource<R extends Resource>(
  world: World,
  res: R,
  values: Partial<ResourceFields<R>>,
): void {
  const data = world.resources.get(res) ?? initResource(world, res);
  for (const key in values) {
    // An explicitly-undefined entry leaves the field untouched (same contract
    // as writeFieldOverrides); exactOptionalPropertyTypes already rejects it
    // at compile time, so this only guards untyped callers.
    if (values[key] !== undefined) {
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
 */
export function resetResource(world: World, res: Resource): void {
  const data = world.resources.get(res);
  if (data === undefined) {
    initResource(world, res);
    return;
  }
  fillFromDefaults(data, getResourceMeta(res));
}
