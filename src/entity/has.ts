/**
 * Optional-component presence checks: `has` (AND) and `hasAny` (OR).
 */

import type { ComponentDescriptor } from "../component.js";
import { isComponentDescriptor } from "../component.js";
import type { EntityId } from "../entity-id.js";
import { entityIndex } from "../entity-id.js";
import { ERROR_OPTIONAL_CHECK_EMPTY, errorNotOptional } from "../errors.js";
import type { Storage, World } from "../world.js";
import { resolveEntityArch } from "./common.js";
import type {
  AllNames,
  ArchetypeOfStorage,
  CheckOptional,
  CheckOptionalList,
  OptionalNames,
  PromotedComponents,
  PromoteOptionals,
} from "./optional-types.js";

/**
 * Build the combined presence bitmask for a list of optional components.
 *
 * @param storage - Storage whose archetype assigns the presence bits; every
 *   listed component must be declared optional on it.
 * @param componentIds - Components to combine; order is irrelevant and
 *   duplicates collapse into one bit.
 * @returns The OR of each component's presence bit, ready to mask a row's
 *   `storage.mask` entry.
 * @throws If `componentIds` is empty.
 * @throws If a listed component is not optional on the storage's archetype,
 *   whether required there or absent.
 */
function buildOptionalMask(storage: Storage, componentIds: readonly ComponentDescriptor[]): number {
  if (componentIds.length === 0) {
    throw new Error(ERROR_OPTIONAL_CHECK_EMPTY);
  }

  let combined = 0;
  for (const component of componentIds) {
    const bit = storage.optionalBitLookup.get(component);
    if (bit === undefined) {
      throw new Error(errorNotOptional(component.__ecstatic_name));
    }
    combined |= bit;
  }
  return combined;
}

function checkOptionalMask(
  storageOrWorld: Storage | World,
  id: EntityId,
  componentIds: readonly ComponentDescriptor[],
): [masked: number, combined: number] {
  const storage = resolveEntityArch(storageOrWorld, id);
  // oxlint-disable-next-line typescript/no-non-null-assertion -- id validated by resolveEntityArch
  const di = storage.sparse[entityIndex(id)]!;
  const combined = buildOptionalMask(storage, componentIds);
  // oxlint-disable-next-line typescript/no-non-null-assertion -- di is a valid dense index
  return [storage.mask[di]! & combined, combined];
}

/**
 * Returns true if the entity has ALL the specified optional components
 * enabled. The array form is AND over every listed component; "has none" is
 * `!hasAny(...)`. On a typed storage the guard narrows the storage type by
 * recording the proven components (phantom promotion) — and stays usable as a
 * plain boolean. The world form dispatches by id to the owning storage.
 *
 * @param storage - Storage the entity lives in, or in the world form the
 *   world to resolve it from; on success the storage guard narrows this
 *   value's type to record the proven components.
 * @param id - Generational entity id, validated for staleness only under
 *   DEBUG.
 * @param comp - One component declared optional on the storage's archetype;
 *   the array form takes a non-empty list and requires all of them.
 * @returns `true` when the component's presence bit is set on the entity's
 *   row (every listed component's bit, in the array form).
 * @throws If any component is not optional on the archetype
 * @throws If the array form is given an empty list
 * @throws If DEBUG and the entity ID is stale
 */
export function has<S extends Storage, C extends ComponentDescriptor>(
  storage: S,
  id: EntityId,
  comp: CheckOptional<C, AllNames<ArchetypeOfStorage<S>>, OptionalNames<ArchetypeOfStorage<S>>>,
): storage is S & PromoteOptionals<C> & PromotedComponents<C>;
export function has<
  S extends Storage,
  const Cs extends readonly [ComponentDescriptor, ...ComponentDescriptor[]],
>(
  storage: S,
  id: EntityId,
  comps: [...Cs] &
    CheckOptionalList<AllNames<ArchetypeOfStorage<S>>, OptionalNames<ArchetypeOfStorage<S>>, Cs>,
): storage is S & PromoteOptionals<Cs[number]> & PromotedComponents<Cs[number]>;
export function has(
  world: World,
  id: EntityId,
  comp: ComponentDescriptor | readonly ComponentDescriptor[],
): boolean;
export function has(
  storageOrWorld: Storage | World,
  id: EntityId,
  componentOrArray: ComponentDescriptor | readonly ComponentDescriptor[] | string,
): boolean {
  if (isComponentDescriptor(componentOrArray)) {
    const storage = resolveEntityArch(storageOrWorld, id);
    // oxlint-disable-next-line typescript/no-non-null-assertion -- entity validated; sparse[entityIndex] is populated
    const di = storage.sparse[entityIndex(id)]!;
    const bit = storage.optionalBitLookup.get(componentOrArray);
    if (bit === undefined) {
      throw new Error(errorNotOptional(componentOrArray.__ecstatic_name));
    }
    // oxlint-disable-next-line typescript/no-non-null-assertion -- di is a valid dense index
    return (storage.mask[di]! & bit) === bit;
  }
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the public overloads only admit component arrays here; the impl's `string` arm exists solely for sentence-error types
  const componentIds = componentOrArray as readonly ComponentDescriptor[];
  const [masked, combined] = checkOptionalMask(storageOrWorld, id, componentIds);
  return masked === combined;
}

/**
 * Returns true if the entity has AT LEAST ONE of the specified optional
 * components enabled (OR). Takes a component array — use `has()` for a
 * single component. The world form dispatches by id to the owning storage.
 *
 * @param storage - Storage the entity lives in, or in the world form the
 *   world to resolve it from.
 * @param id - Generational entity id, validated for staleness only under
 *   DEBUG.
 * @param comps - Non-empty list of components declared optional on the
 *   storage's archetype.
 * @returns `true` when at least one listed component's presence bit is set on
 *   the entity's row.
 * @throws If any component is not optional on the archetype
 * @throws If given an empty list
 * @throws If DEBUG and the entity ID is stale
 */
export function hasAny<
  S extends Storage,
  const Cs extends readonly [ComponentDescriptor, ...ComponentDescriptor[]],
>(
  storage: S,
  id: EntityId,
  comps: [...Cs] &
    CheckOptionalList<AllNames<ArchetypeOfStorage<S>>, OptionalNames<ArchetypeOfStorage<S>>, Cs>,
): boolean;
export function hasAny(world: World, id: EntityId, comps: readonly ComponentDescriptor[]): boolean;
export function hasAny(
  storage: Storage,
  id: EntityId,
  comps: "a component array — use has() for a single component",
): boolean;
export function hasAny(
  storageOrWorld: Storage | World,
  id: EntityId,
  componentIds: readonly ComponentDescriptor[] | string,
): boolean {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the public overloads only admit component arrays here; the impl's `string` arm exists solely for sentence-error types
  const comps = componentIds as readonly ComponentDescriptor[];
  const [masked] = checkOptionalMask(storageOrWorld, id, comps);
  return masked !== 0;
}
