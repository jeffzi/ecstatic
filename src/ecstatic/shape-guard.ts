/**
 * Runtime shape guard for optimizer-generated code: checks that a storage's archetype still has the
 * shape the optimizer compiled a call site against.
 */

import type { ArchetypeDescriptor } from "./archetype.js";
import type { ComponentDescriptor } from "./component.js";
import { getRelationMeta } from "./relation.js";
import type { Storage } from "./world.js";

/**
 * Shape key of each storage already checked. An archetype never changes shape after creation, so a
 * storage's key is computed once and a warm call is one lookup and one string comparison.
 */
const shapeKeys = new WeakMap<object, string>();

/**
 * Column kind code of one field default.
 *
 * @param defaultValue - A normalized default from `__ecstatic_default_values`: a width marker is
 *   already unwrapped to its number and a `ref()` field holds `undefined`.
 * @returns `b` for a boolean, `n` for a number, `p` for anything stored in a plain array.
 */
function fieldKindCode(defaultValue: unknown): string {
  if (typeof defaultValue === "boolean") return "b";
  if (typeof defaultValue === "number") return "n";
  return "p";
}

/**
 * Shape key of one component.
 *
 * @param comp - Component or relation descriptor; its `__ecstatic_fields` are already in UTF-16
 *   code unit order, and a relation's `target` column is not among them.
 * @returns `c` (or `r` for a relation), the length-prefixed name, then `{…}` holding each field as
 *   `<length>:<name>=<kind>`.
 */
function componentShapeKey(comp: ComponentDescriptor): string {
  const defaults = comp.__ecstatic_default_values;
  const fields = comp.__ecstatic_fields.map(
    (name, i) => `${name.length}:${name}=${fieldKindCode(defaults[i])}`,
  );
  const marker = getRelationMeta(comp) === undefined ? "c" : "r";
  return `${marker}${comp.__ecstatic_component_key}{${fields.join(",")}}`;
}

/**
 * Shape key of an archetype. The format is a contract: the build-time optimizer computes the same
 * key for a call site, byte for byte, so any change here must change there too.
 *
 * @param arch - Archetype whose component lists are keyed.
 * @returns The required components' keys, `|`, then the optional components' keys, each list in
 *   declaration order.
 */
function archetypeShapeKey(arch: ArchetypeDescriptor): string {
  let key = "";
  for (const comp of arch.components) key += componentShapeKey(comp);
  key += "|";
  for (const comp of arch.optionals) key += componentShapeKey(comp);
  return key;
}

/**
 * Reads the archetype a storage-like object carries.
 *
 * @param storage - Untrusted object the call site reads as a storage.
 * @returns Its `archetype` metadata, or `undefined` when it carries none.
 */
function archetypeOf(storage: object): ArchetypeDescriptor | undefined {
  const meta: Partial<Pick<Storage, "archetype">> = storage;
  return meta.archetype;
}

/**
 * Error for a value handed to the guard that carries no archetype.
 *
 * @param key - Shape key the call site expected.
 * @returns The error naming `key` and the missing archetype.
 */
function noArchetypeError(key: string): Error {
  return new Error(`ecstatic: shape guard expected ${key}, got a value with no archetype`);
}

/**
 * Check that a storage's archetype has the shape an optimized call site was compiled against.
 *
 * Always checks: it has no `NDEBUG` gate, and must not gain one; the caller decides whether to
 * invoke it.
 *
 * The input is untrusted: generated code passes whatever value the call site holds, and a cast in
 * user code can make that value anything, `null` and `undefined` included.
 *
 * @param storage - Value the call site reads as a storage; only its `archetype` metadata is
 *   consulted.
 * @param key - Shape key the optimizer computed for the site.
 * @throws Error naming the expected and the actual shape when they differ.
 * @throws Error naming the expected shape when `storage` carries no archetype.
 */
export function assertShape(storage: unknown, key: string): void {
  if (typeof storage !== "object" || storage === null) throw noArchetypeError(key);
  let actual = shapeKeys.get(storage);
  if (actual === undefined) {
    const arch = archetypeOf(storage);
    if (arch === undefined) throw noArchetypeError(key);
    actual = archetypeShapeKey(arch);
    shapeKeys.set(storage, actual);
  }
  if (actual !== key) {
    throw new Error(`ecstatic: shape guard expected ${key}, got ${actual}`);
  }
}

/**
 * Check that a storage's archetype holds, or lacks, a component an optimized call site's filter
 * was resolved against at build time.
 *
 * Always checks: it has no `NDEBUG` gate, and must not gain one; the caller decides whether to
 * invoke it.
 *
 * Membership is by descriptor identity: a different descriptor that shares the component's name
 * is not held.
 *
 * @param storage - Value the call site reads as a storage; untrusted, as for {@link assertShape}.
 *   Only its `archetype` metadata is consulted.
 * @param component - Component the build resolved the filter against.
 * @param expectPresent - Whether the build expected `component` in the storage's archetype.
 * @throws Error naming `component` and the expected presence when the archetype disagrees.
 * @throws Error naming `component` when `storage` carries no archetype.
 */
export function assertFilterMember(
  storage: unknown,
  component: ComponentDescriptor,
  expectPresent: boolean,
): void {
  const arch = typeof storage === "object" && storage !== null ? archetypeOf(storage) : undefined;
  if (arch === undefined) {
    throw filterGuardError(component, expectPresent, ", got a value with no archetype");
  }
  if (arch.componentLookup.has(component) !== expectPresent) {
    throw filterGuardError(component, expectPresent, " in the storage's archetype");
  }
}

/**
 * Error for a storage that fails the filter guard.
 *
 * @param component - Component the build resolved the filter against.
 * @param expectPresent - Whether the build expected it in the storage's archetype.
 * @param detail - Suffix appended verbatim after the expectation, including its leading separator.
 * @returns The error whose message names the component and whether the build expected it present
 *   or absent, then appends `detail`.
 */
function filterGuardError(
  component: ComponentDescriptor,
  expectPresent: boolean,
  detail: string,
): Error {
  return new Error(
    `ecstatic: filter guard expected ${component.__ecstatic_name} ${expectPresent ? "present" : "absent"}${detail}`,
  );
}
