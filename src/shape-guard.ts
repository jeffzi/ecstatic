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
const shapeKeys = new WeakMap<Storage, string>();

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
  const parts: string[] = [];
  for (const [i, name] of comp.__ecstatic_fields.entries()) {
    parts.push(`${name.length}:${name}=${fieldKindCode(defaults[i])}`);
  }
  const marker = getRelationMeta(comp) === undefined ? "c" : "r";
  return `${marker}${comp.__ecstatic_component_key}{${parts.join(",")}}`;
}

/**
 * Shape key of an archetype, in the format the optimizer's `ArchShape.Key` writes.
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
 * Check that a storage's archetype has the shape an optimized call site was compiled against.
 *
 * Checks regardless of `NDEBUG`: generated code gates the call behind its own `DEBUG` copy.
 *
 * @param storage - Storage the call site reads; only its `archetype` metadata is consulted.
 * @param key - Shape key the optimizer computed for the site.
 * @throws Error naming the expected and the actual shape when they differ.
 * @throws Error naming the expected shape when `storage` carries no archetype.
 */
export function assertShape(storage: Storage, key: string): void {
  let actual = shapeKeys.get(storage);
  if (actual === undefined) {
    // Generated code may hand over any value; widen so a missing archetype is checked, not assumed.
    const meta: Partial<Pick<Storage, "archetype">> = storage;
    const arch = meta.archetype;
    if (arch === undefined) {
      throw new Error(`ecstatic: shape guard expected ${key}, got a value with no archetype`);
    }
    actual = archetypeShapeKey(arch);
    shapeKeys.set(storage, actual);
  }
  if (actual !== key) {
    throw new Error(`ecstatic: shape guard expected ${key}, got ${actual}`);
  }
}
