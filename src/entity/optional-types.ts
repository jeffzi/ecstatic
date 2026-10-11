/**
 * Type-level utilities for optional-component operations: compile-time
 * validation of `has`/`enable`/`disable` arguments and narrowing predicates
 * for `has` guards.
 */

import type { ArchetypeDescriptor, ComponentsOf, OptionalsOf } from "../archetype.js";
import type { ComponentDescriptor, ComponentFields, ComponentName } from "../component.js";
import type { SoAColumns, Storage } from "../world.js";
import type { IsTagFields, OptionalSpawnValue } from "./spawn.js";

/** Archetype captured by a storage's type parameter (wide for a bare Storage). */
export type ArchetypeOfStorage<S> = S extends Storage<infer A> ? A : ArchetypeDescriptor;

/** Union of every component name on an archetype (required + optional). */
export type AllNames<A> = ComponentName<ComponentsOf<A>[number] | OptionalsOf<A>[number]>;

/**
 * Union of optional component names on an archetype; a wide (untyped)
 * archetype yields `string`, which makes {@link CheckOptional} skip
 * compile-time validation.
 */
export type OptionalNames<A> = ComponentName<OptionalsOf<A>[number]>;

/**
 * Validates that a component is optional on the archetype: resolves to the
 * component itself when valid and to a sentence-shaped error type at the
 * argument position otherwise. An untyped storage (wide name unions) accepts
 * any component — runtime validation still applies.
 */
export type CheckOptional<C, All extends string, Opts extends string> = string extends Opts
  ? C
  : C extends { readonly __ecstatic_relation_meta: object }
    ? C extends { readonly __ecstatic_name: infer N extends string }
      ? `an optional component (${N} is a relation — use link()/unlink() instead)`
      : never
    : C extends { readonly __ecstatic_name: Opts }
      ? C
      : C extends { readonly __ecstatic_name: infer N extends string }
        ? N extends All
          ? `an optional component (${N} is required, not optional)`
          : `an optional component (${N} is not on this archetype)`
        : never;

/** Tuple form of {@link CheckOptional}: validates every element. */
export type CheckOptionalList<
  All extends string,
  Opts extends string,
  Comps extends readonly ComponentDescriptor[],
> = {
  [I in keyof Comps]: CheckOptional<Comps[I], All, Opts>;
};

/** Excludes tag components (zero-field) from a component union (distributive). */
type ExcludeTags<C> = C extends ComponentDescriptor
  ? IsTagFields<ComponentFields<C>> extends true
    ? never
    : C
  : never;

declare const __ecstatic_promoted: unique symbol;

/**
 * Phantom marker recording which optional components a `has()` guard proved
 * present — a dedicated slot separate from the SoA column namespace, so the
 * narrowing can never interfere with `CheckOptional` validation. Includes
 * tags: a `has()` on a tag proves the tag even though it has no columns.
 *
 * The property is optional so runtime storage values (which never carry it)
 * stay assignable, and so intersecting two guards merges their key records.
 */
export type PromotedComponents<Comps extends ComponentDescriptor> = {
  readonly [__ecstatic_promoted]?: { [C in Comps as ComponentName<C>]: true };
};

/**
 * Promotes optional data components to concrete column slots on a storage
 * type. Used by `has()` type predicates: the intersection records the proven
 * components for downstream consumers. The promotion is inert to callers —
 * `has()` remains usable as a plain boolean, and consumers must not depend
 * on the recorded slots.
 */
export type PromoteOptionals<Comps extends ComponentDescriptor> = {
  [C in ExcludeTags<Comps> as ComponentName<C>]: SoAColumns;
};

/**
 * Record form for enable/enableMany: keys are optional component names; tags
 * accept booleans, data optionals accept a boolean or a partial field record.
 * `never` (uncallable) when the archetype declares no optionals; the untyped
 * record for a bare storage.
 */
export type OptionalOverridesFor<A extends ArchetypeDescriptor> = ArchetypeDescriptor extends A
  ? Record<string, Record<string, unknown> | boolean>
  : [OptionalsOf<A>[number]] extends [never]
    ? never
    : { [P in OptionalsOf<A>[number] as ComponentName<P>]?: OptionalSpawnValue<P> };
