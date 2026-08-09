/**
 * Relation system: one-to-one typed entity links.
 *
 * A relation is a component with a reserved `target` SoA column (created at
 * archetype registration) and an optional set of target constraints. Relation
 * names share the component name namespace, and a relation descriptor slots
 * into archetype tuples like any component descriptor.
 */

import {
  type Component,
  type ComponentDescriptor,
  createDescriptor,
  type FieldDefault,
  type FieldDescriptor,
  type InferFields,
} from "./component.js";
import type { EntityId } from "./entity-id.js";

/** Full runtime descriptor for a registered relation. Extends ComponentDescriptor. */
export interface RelationDescriptor extends ComponentDescriptor {
  readonly isRelation: true;
  readonly constraints: ComponentDescriptor[];
}

/**
 * The relation's synthetic `target` field descriptor: readable through `get`
 * like any field, but branded so `set` can reject writes at compile time —
 * the target column is owned by `link`/`unlink`.
 */
export interface RelationTargetFieldDescriptor extends FieldDescriptor<EntityId> {
  readonly __ecstatic_relation_target: true;
}

/**
 * A typed entity-link descriptor. Extends `Component<N, T>` so it slots into
 * archetype tuples unchanged — the synthetic `target` field joins the data
 * fields in the mapped field descriptors (branded so only `link` can write
 * it). The `__ecstatic_relation_meta` slot is additive: its presence is what
 * distinguishes a relation from a plain component at the type level.
 *
 * @typeParam N - Literal string name (e.g. `"Owner"`).
 * @typeParam T - Shape of the relation's extra data fields. `{}` for pure links.
 * @typeParam Constraints - Components the target entity must have. `[]` admits any entity.
 */
export type Relation<
  N extends string = string,
  T extends object = object,
  Constraints extends readonly Component[] = readonly Component[],
> = Component<N, T & { target: EntityId }> & {
  readonly __ecstatic_relation_meta: { constraints: Constraints; fields: T };
  readonly target: RelationTargetFieldDescriptor;
};

/** Extracts the constraint tuple from a `Relation`. */
export type RelationConstraints<R> = R extends {
  readonly __ecstatic_relation_meta: { constraints: infer C extends readonly Component[] };
}
  ? C
  : never;

/** Extracts the data-fields record (without `target`) from a `Relation`. */
export type RelationFields<R> = R extends {
  readonly __ecstatic_relation_meta: { fields: infer T extends object };
}
  ? T
  : never;

/**
 * Compile-time rejection of a `target` key in relation defaults — `target` is
 * reserved for the relation's link column.
 */
export type CheckRelationTarget<T> = "target" extends keyof T
  ? {
      readonly __reserved_target_error: "The field name 'target' is reserved for relation targets";
    }
  : object;

/** Empty data-fields shape for pure links (intersects cleanly with the target slot). */
type NoFields = NonNullable<unknown>;

/**
 * Returns the relation descriptor if `value` is a relation, `undefined` otherwise.
 *
 * Use this at runtime to distinguish relations from plain components when the
 * static type is unknown (e.g. registration wiring, reverse-map traversal).
 */
export function getRelationMeta(value: unknown): RelationDescriptor | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  if (!("isRelation" in value) || value.isRelation !== true) {
    return undefined;
  }
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the isRelation flag is only set by relation()
  return value as RelationDescriptor;
}

/**
 * Define a one-to-one relation descriptor.
 *
 * - `relation("Name")` — pure link, no data fields, no constraints.
 * - `relation("Name", [Comp])` — constrains target entity to have the given components.
 * - `relation("Name", { offsetX: 0 })` — data-carrying relation with no constraints (two-arg shorthand).
 * - `relation("Name", [Comp], { offsetX: 0 })` — data-carrying relation with constraints.
 *
 * `target` is a reserved field name; declaring it in `defaults` is rejected at
 * compile time and causes a runtime error. Relation names share the component
 * name namespace — duplicates are rejected.
 */
export function relation<N extends string>(name: N): Relation<N, NoFields, []>;
export function relation<N extends string, T extends Record<string, FieldDefault>>(
  name: N,
  defaults: (T extends readonly unknown[] ? never : T) & CheckRelationTarget<T>,
): Relation<N, InferFields<T>, []>;
export function relation<N extends string, Comps extends Component[]>(
  name: N,
  constraints: [...Comps],
): Relation<N, NoFields, Comps>;
export function relation<
  N extends string,
  Comps extends Component[],
  T extends Record<string, FieldDefault>,
>(
  name: N,
  constraints: [...Comps],
  defaults: T & CheckRelationTarget<T>,
): Relation<N, InferFields<T>, Comps>;
export function relation(
  name: string,
  arg2?: ComponentDescriptor[] | Record<string, unknown>,
  arg3?: Record<string, unknown>,
): unknown {
  // Parse arguments: detect whether arg2 is a constraints array or defaults object
  const isArg2Array = Array.isArray(arg2);

  const constraints: ComponentDescriptor[] = isArg2Array ? arg2 : [];

  const defaults: Record<string, unknown> = arg3 ?? (isArg2Array ? {} : (arg2 ?? {}));

  if ("target" in defaults) {
    throw new Error(`relation field name 'target' is reserved: ${name}`);
  }

  const descriptor = createDescriptor(name, defaults);

  descriptor.isRelation = true;

  descriptor.constraints = constraints;

  // Attach synthetic `target` field descriptor so `get(storage, id, Rel.target)` works.
  // The target SoA column is created at archetype initialization; this descriptor
  // enables the standard field-access resolution path to find it.
  descriptor.target = {
    __ecstatic_component: descriptor,
    __ecstatic_field: "target",
  };

  return descriptor;
}
