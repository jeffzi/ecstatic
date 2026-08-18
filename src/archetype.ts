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
export interface ArchetypeDescriptor<
  C extends readonly ComponentDescriptor[] = readonly ComponentDescriptor[],
  O extends readonly ComponentDescriptor[] = readonly ComponentDescriptor[],
> {
  readonly id: number;
  readonly components: C;
  readonly optionals: O;
  readonly componentByName: Map<string, ComponentDescriptor>;
  readonly componentLookup: Set<ComponentDescriptor>;
  readonly optionalBits: Map<string, number>;
  readonly optionalNotBits: Map<string, number>;
  readonly optionalBitLookup: Map<ComponentDescriptor, number>;
  readonly optionalNotBitLookup: Map<ComponentDescriptor, number>;
  readonly archetype: ArchetypeDescriptor<C, O>;
}

/**
 * Base class produced by {@link Archetype}, carrying the canonical descriptor
 * of the archetype it declares.
 */
interface ArchetypeDeclarationBase {
  readonly __ecstatic_archetype: ArchetypeDescriptor;
}

/**
 * An archetype in either declaration form: the descriptor returned by
 * {@link archetype}, or a class declared with
 * `class Ship extends Archetype(...) {}`.
 */
export type ArchetypeRef<A extends ArchetypeDescriptor = ArchetypeDescriptor> =
  | A
  | (new (...args: never[]) => A);

/** Component tuple captured by a typed archetype descriptor. */
export type ComponentsOf<A> =
  A extends ArchetypeDescriptor<infer C> ? C : readonly ComponentDescriptor[];

/** Optionals tuple captured by a typed archetype descriptor. */
export type OptionalsOf<A> =
  A extends ArchetypeDescriptor<readonly ComponentDescriptor[], infer O>
    ? O
    : readonly ComponentDescriptor[];

/** Module-level counter for archetype IDs */
let nextArchetypeId = 0;

/** Module-level canonicalization cache: concatenated key → descriptor */
const archetypeCache = new Map<string, ArchetypeDescriptor>();

/** Maximum number of optional components per archetype (32-bit bitmask limit). */
const MAX_OPTIONAL_COMPONENTS = 32;

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
  "hasDespawnClear",
  "hasOptionalData",
  "matchers",
  "matcherMatched",
  // Relation bookkeeping
  "relationTargetColumns",
  "relationDescriptors",
  "relationOptionalBits",
  "relationN",
  "hasRelations",
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
  const reqParts = required.map((comp) => comp.__ecstatic_component_key).join("");
  const optParts = optionals.map((comp) => comp.__ecstatic_component_key).join("");
  return `req:${reqParts}|opt:${optParts}`;
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
export function archetype<
  const C extends readonly ComponentDescriptor[] = readonly [],
  const O extends readonly ComponentDescriptor[] = readonly [],
>(required?: C, optionals?: O): ArchetypeDescriptor<C, O>;
export function archetype(
  required: readonly ComponentDescriptor[] = [],
  optionals: readonly ComponentDescriptor[] = [],
): ArchetypeDescriptor {
  validateArchetype(required, optionals);

  const key = computeArchetypeKey(required, optionals);
  const cached = archetypeCache.get(key);
  if (cached) {
    return cached;
  }

  const descriptor = buildArchetypeDescriptor(required, optionals);

  archetypeCache.set(key, descriptor);
  return descriptor;
}

/**
 * Declare an archetype as a class, so the type carries the name you give it:
 *
 * ```ts
 * class Ship extends Archetype([Position, Health], [Frozen]) {}
 * const ships = register(world, Ship);
 * ```
 *
 * The returned constructor is a declaration, not a value factory: it must be
 * subclassed, and neither it nor its subclasses may be instantiated. The single
 * `never` parameter turns `new Ship()` into a compile error; the runtime guard
 * catches callers that cast past it.
 *
 * Component lists are validated and canonicalized by {@link archetype}, so a
 * class and an equivalent descriptor name the same archetype.
 *
 * The declared lists stay readable as `components` and `optionals` statics, with
 * their tuple types intact, so one declaration composes into another:
 *
 * ```ts
 * class Vehicle extends Archetype([Position, Health], [Frozen]) {}
 * class Tank extends Archetype([...Vehicle.components, Cannon], [...Vehicle.optionals]) {}
 * ```
 *
 * @param required - Component descriptors required on every entity in this archetype
 * @param optionals - Component descriptors that may or may not be present (up to 32)
 * @returns A constructor to extend, carrying the canonical archetype descriptor
 *
 * @throws Whatever {@link archetype} throws for the given component lists
 */
export function Archetype<
  const C extends readonly ComponentDescriptor[] = readonly [],
  const O extends readonly ComponentDescriptor[] = readonly [],
>(
  required?: C,
  optionals?: O,
): (new (archetypeClassesAreNotConstructable: never) => ArchetypeDescriptor<C, O>) & {
  readonly components: C;
  readonly optionals: O;
};
export function Archetype(
  required: readonly ComponentDescriptor[] = [],
  optionals: readonly ComponentDescriptor[] = [],
): (new (archetypeClassesAreNotConstructable: never) => ArchetypeDescriptor) & {
  readonly components: readonly ComponentDescriptor[];
  readonly optionals: readonly ComponentDescriptor[];
} {
  const descriptor = archetype(required, optionals);

  // The instance type is unreachable — the constructor always throws — so merging
  // the descriptor into it costs no runtime members and lets `register(world, Ship)`
  // read the archetype straight off the class's instance type.
  // oxlint-disable-next-line typescript/no-unsafe-declaration-merging -- uninitialized merged members are unobservable without an instance
  interface ArchetypeDeclaration extends ArchetypeDescriptor {}

  class ArchetypeDeclaration {
    static readonly __ecstatic_archetype: ArchetypeDescriptor = descriptor;

    /** Required components of the declared archetype, in declaration order. */
    static readonly components: readonly ComponentDescriptor[] = descriptor.components;

    /** Optional components of the declared archetype, in declaration order. */
    static readonly optionals: readonly ComponentDescriptor[] = descriptor.optionals;

    constructor() {
      throw new Error(
        "archetype classes are declarations, not instances: use `class Ship extends Archetype(...) {}` and pass the class itself",
      );
    }
  }

  return ArchetypeDeclaration;
}

/** Type guard for the class {@link Archetype} returns, before it is subclassed. */
function isArchetypeDeclarationBase(value: unknown): value is ArchetypeDeclarationBase {
  return typeof value === "function" && Object.hasOwn(value, "__ecstatic_archetype");
}

/**
 * Resolve an archetype in either declaration form to its canonical descriptor.
 *
 * @param arch - An archetype descriptor, or a class extending {@link Archetype}
 * @returns The canonical descriptor the argument names
 *
 * @throws If given the {@link Archetype} return value itself, which carries no name
 * @throws If given a class that does not extend {@link Archetype} directly
 */
export function resolveArchetype(arch: ArchetypeRef): ArchetypeDescriptor {
  if (typeof arch !== "function") {
    return arch;
  }

  if (isArchetypeDeclarationBase(arch)) {
    throw new Error(
      "an Archetype() result must be subclassed to carry a name: declare `class Ship extends Archetype(...) {}` and pass Ship",
    );
  }

  const base: unknown = Object.getPrototypeOf(arch);
  if (!isArchetypeDeclarationBase(base)) {
    throw new Error(
      `${arch.name} must extend Archetype() directly; extending a declared archetype class would give one archetype two names`,
    );
  }

  return base.__ecstatic_archetype;
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
  if (optionals.length > MAX_OPTIONAL_COMPONENTS) {
    throw new Error(`archetype supports at most ${MAX_OPTIONAL_COMPONENTS} optional components`);
  }

  const seenComponents = new Set<ComponentDescriptor>();
  const allComponents = [...required, ...optionals];

  for (const comp of allComponents) {
    if (!isComponentDescriptor(comp)) {
      throw new Error("expected ComponentDescriptor");
    }

    if (seenComponents.has(comp)) {
      throw new Error(`duplicate component ${comp.__ecstatic_name} in archetype`);
    }
    seenComponents.add(comp);

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

  const componentByName = new Map<string, ComponentDescriptor>();
  const componentLookup = new Set<ComponentDescriptor>();

  for (const comp of [...required, ...optionals]) {
    componentByName.set(comp.__ecstatic_name, comp);
    componentLookup.add(comp);
  }

  // Bits are assigned as 1, 2, 4, 8, ... in declaration order
  const optionalBits = new Map<string, number>();
  const optionalNotBits = new Map<string, number>();
  const optionalBitLookup = new Map<ComponentDescriptor, number>();
  const optionalNotBitLookup = new Map<ComponentDescriptor, number>();

  for (let i = 0; i < optionals.length; i++) {
    const comp = optionals[i];
    /* istanbul ignore next */
    if (comp === undefined) throw new Error("invariant: optional index out of bounds");
    const bit = 1 << i;
    const notBit = ~bit >>> 0; // 32-bit bitwise complement

    optionalBits.set(comp.__ecstatic_name, bit);
    optionalNotBits.set(comp.__ecstatic_name, notBit);
    optionalBitLookup.set(comp, bit);
    optionalNotBitLookup.set(comp, notBit);
  }

  // Cast to mutable to allow self-reference setup
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- mutable construction
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
