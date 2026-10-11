/**
 * Content comparison shared by the component and resource registries.
 *
 * Idempotent registration compares a re-declaration against the registered one; declarations are
 * re-evaluated under hot module reload, so containers in defaults are fresh literals and must
 * compare by content rather than identity.
 */

/**
 * True for objects whose prototype is `Object.prototype` or `null` — i.e. records, not instances.
 *
 * @param v - Non-null object to classify; arrays and class instances fail the check.
 * @returns `true` when `v` is a plain record, which also narrows it to an indexable type.
 */
export function isPlainRecord(v: object): v is Record<string, unknown> {
  const proto: unknown = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

function arraysEqual(a: unknown[], b: unknown[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (!structurallyEqual(a[i], b[i])) return false;
  }
  return true;
}

function mapsEqual(a: Map<unknown, unknown>, b: Map<unknown, unknown>): boolean {
  if (a.size !== b.size) return false;
  for (const [key, val] of a) {
    if (!b.has(key) || !structurallyEqual(val, b.get(key))) return false;
  }
  return true;
}

function setsEqual(a: Set<unknown>, b: Set<unknown>): boolean {
  if (a.size !== b.size) return false;
  for (const member of a) {
    if (!b.has(member)) return false;
  }
  return true;
}

function recordsEqual(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const keysA = Object.keys(a);
  if (keysA.length !== Object.keys(b).length) return false;
  for (const key of keysA) {
    if (!Object.hasOwn(b, key) || !structurallyEqual(a[key], b[key])) return false;
  }
  return true;
}

/**
 * Type-dispatch comparison for two non-null objects. Falls through to identity for class
 * instances: they fail the `isPlainRecord` check, so the `a === b` at the top of
 * `structurallyEqual` is their only match. Functions never get here; the `typeof` guard
 * there already rejects them.
 *
 * @param a - Left operand; a non-null object, since `structurallyEqual` has already ruled out primitives.
 * @param b - Right operand; a different container kind than `a` compares unequal without recursing.
 * @returns `true` when both are the same container kind with structurally equal contents.
 */
function objectsEqual(a: object, b: object): boolean {
  if (Array.isArray(a)) return Array.isArray(b) && arraysEqual(a, b);
  if (Array.isArray(b)) return false;
  if (a instanceof Date) return b instanceof Date && a.getTime() === b.getTime();
  if (b instanceof Date) return false;
  if (a instanceof Map) return b instanceof Map && mapsEqual(a, b);
  if (b instanceof Map) return false;
  if (a instanceof Set) return b instanceof Set && setsEqual(a, b);
  if (b instanceof Set) return false;
  if (!isPlainRecord(a) || !isPlainRecord(b)) return false;
  return recordsEqual(a, b);
}

/**
 * Mirrors `cloneUnknown`'s type dispatch for equality instead of copying.
 *
 * Primitives compare by value, records/arrays/`Date`/`Map`/`Set` compare by
 * content (recursing into values), and everything else — functions and class
 * instances — compares by identity (`===`).
 *
 * @param a - Left operand, any value.
 * @param b - Right operand, any value.
 * @returns `true` when the two are equal under the dispatch above; `NaN` never equals itself.
 */
export function structurallyEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || a === null || typeof b !== "object" || b === null) return false;
  return objectsEqual(a, b);
}
