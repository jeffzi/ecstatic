/**
 * Archetype system: define entity shapes by composing components.
 *
 * An archetype is a static descriptor binding a required component list and a set of
 * pre-declared optional components. Archetypes are canonicalized: identical component
 * lists return the same object. Optional component presence is tracked via a bitmask
 * (up to 32 optionals per archetype, 2^K bits: 1, 2, 4, 8, ...).
 *
 * Reserved names prevent collisions with archetype storage fields.
 */

import type { ComponentDescriptor } from "./component.js";
import { isComponentDescriptor } from "./component.js";

// Re-export for convenience
export type { ComponentDescriptor } from "./component.js";

/** Archetype descriptor stored in the cache and returned to users */
export interface ArchetypeDescriptor {
  readonly id: number;
  readonly components: readonly ComponentDescriptor[];
  readonly optionals: readonly ComponentDescriptor[];
  readonly componentByName: Map<string, ComponentDescriptor>;
  readonly componentLookup: Set<ComponentDescriptor>;
  readonly optionalBits: Map<string, number>;
  readonly optionalNotBits: Map<string, number>;
  readonly optionalBitLookup: Map<ComponentDescriptor, number>;
  readonly optionalNotBitLookup: Map<ComponentDescriptor, number>;
  readonly archetype: ArchetypeDescriptor;
}

/** Module-level counter for archetype IDs */
let nextArchetypeId = 0;

/** Module-level canonicalization cache: concatenated key → descriptor */
const archetypeCache = new Map<string, ArchetypeDescriptor>();

/** Field names and properties reserved by the archetype storage itself */
const RESERVED_NAMES = new Set<string>([
  // Storage structure fields
  "entities",
  "sparse",
  "n",
  "mask",
  "columns",
  "flatColumns",
  "world",
  // Archetype descriptor fields
  "id",
  "components",
  "optionals",
  "componentByName",
  "componentLookup",
  "optionalBits",
  "optionalNotBits",
  "optionalBitLookup",
  "optionalNotBitLookup",
  "archetype",
  // Runtime bookkeeping
  "generation",
  "despawnClear",
]);

/**
 * Compute the canonicalization key for an archetype:
 * format: `req:<key1><key2>...|opt:<key1><key2>...`
 * where each <keyN> is the component's __ecstatic_component_key.
 */
function computeArchetypeKey(
  required: readonly ComponentDescriptor[],
  optionals: readonly ComponentDescriptor[],
): string {
  const reqParts: string[] = [];
  for (const comp of required) {
    reqParts.push(comp.__ecstatic_component_key);
  }
  const optParts: string[] = [];
  for (const comp of optionals) {
    optParts.push(comp.__ecstatic_component_key);
  }
  return `req:${reqParts.join("")}|opt:${optParts.join("")}`;
}

/**
 * Create an archetype descriptor from required and optional component lists.
 * Archetypes are canonicalized: identical lists return the same object (identity cache).
 *
 * @param required - Component descriptors required on every entity in this archetype
 * @param optionals - Component descriptors that may or may not be present (up to 32)
 * @returns A shared, immutable archetype descriptor
 *
 * @throws If more than 32 optional components
 * @throws If any component name is reserved (on archetypes)
 * @throws If any component appears in both required and optional, or twice in one list
 */
export function archetype(
  required: readonly ComponentDescriptor[] = [],
  optionals: readonly ComponentDescriptor[] = [],
): ArchetypeDescriptor {
  // Validate archetype before any cache lookup
  validateArchetype(required, optionals);

  // Compute canonicalization key and check cache
  const key = computeArchetypeKey(required, optionals);
  const cached = archetypeCache.get(key);
  if (cached) {
    return cached;
  }

  // Build the new descriptor
  const descriptor = buildArchetypeDescriptor(required, optionals);

  // Cache it before returning
  archetypeCache.set(key, descriptor);
  return descriptor;
}

/**
 * Validate component lists for an archetype:
 * - No more than 32 optionals
 * - No reserved component names
 * - No duplicate components
 */
function validateArchetype(
  required: readonly ComponentDescriptor[],
  optionals: readonly ComponentDescriptor[],
): void {
  // Check optional count limit
  if (optionals.length > 32) {
    throw new Error("archetype supports at most 32 optional components");
  }

  // Collect all component names and check for duplicates
  const seenComponents = new Set<ComponentDescriptor>();
  const allComponents = [...required, ...optionals];

  for (const comp of allComponents) {
    if (!isComponentDescriptor(comp)) {
      throw new Error("expected ComponentDescriptor");
    }

    // Check for duplicate (same object)
    if (seenComponents.has(comp)) {
      throw new Error(`duplicate component ${comp.__ecstatic_name} in archetype`);
    }
    seenComponents.add(comp);

    // Check for reserved name
    if (RESERVED_NAMES.has(comp.__ecstatic_name)) {
      throw new Error(`component name ${comp.__ecstatic_name} is reserved on archetypes`);
    }
  }
}

/**
 * Construct an archetype descriptor with all required fields and lookups.
 */
function buildArchetypeDescriptor(
  required: readonly ComponentDescriptor[],
  optionals: readonly ComponentDescriptor[],
): ArchetypeDescriptor {
  const id = nextArchetypeId++;

  // Build componentByName and componentLookup
  const componentByName = new Map<string, ComponentDescriptor>();
  const componentLookup = new Set<ComponentDescriptor>();

  for (const comp of required) {
    componentByName.set(comp.__ecstatic_name, comp);
    componentLookup.add(comp);
  }

  for (const comp of optionals) {
    componentByName.set(comp.__ecstatic_name, comp);
    componentLookup.add(comp);
  }

  // Build optional bit tables
  // Bits are assigned as 1, 2, 4, 8, ... in declaration order
  const optionalBits = new Map<string, number>();
  const optionalNotBits = new Map<string, number>();
  const optionalBitLookup = new Map<ComponentDescriptor, number>();
  const optionalNotBitLookup = new Map<ComponentDescriptor, number>();

  for (let i = 0; i < optionals.length; i++) {
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const comp = optionals[i]!;
    const bit = 1 << i; // 2^i: 1, 2, 4, 8, ...
    const notBit = ~bit >>> 0; // 32-bit bitwise complement

    optionalBits.set(comp.__ecstatic_name, bit);
    optionalNotBits.set(comp.__ecstatic_name, notBit);
    optionalBitLookup.set(comp, bit);
    optionalNotBitLookup.set(comp, notBit);
  }

  // Create the descriptor object (cast to mutable to allow self-reference setup)
  const desc = {
    id,
    components: required,
    optionals,
    componentByName,
    componentLookup,
    optionalBits,
    optionalNotBits,
    optionalBitLookup,
    optionalNotBitLookup,
  } as {
    -readonly [K in keyof ArchetypeDescriptor]: ArchetypeDescriptor[K];
  };

  // Set the self-reference: .archetype === self, uniform .archetype deref for code holding
  // either a storage or an archetype descriptor
  desc.archetype = desc;

  return desc;
}
