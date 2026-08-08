/**
 * Entity iteration: invoke a callback for each entity in a storage.
 *
 * Iterates backward (n−1 down to 0) so despawning the current entity during
 * iteration is safe: swap-and-pop only moves the last row (already visited)
 * into the hole. Spawning during iteration appends at the end — which backward
 * iteration has already passed, so new entities are deterministically not
 * visited in the current pass.
 *
 * Views are reused objects with generated accessors over the columns — no
 * per-entity allocation, and property access stays monomorphic. Each storage
 * keeps one view per nesting depth, so nested each() over the same storage
 * rebinds distinct views.
 */

import type { ArchetypeDescriptor, ComponentsOf, OptionalsOf } from "../archetype.js";
import type { ComponentDescriptor, ComponentFields, ComponentName } from "../component.js";
import type { EntityId } from "../entity-id.js";
import type { EachFilter } from "../filter.js";
import { resolveFilter } from "../filter.js";
import type { Matcher } from "../matcher.js";
import type { SoAColumns, Storage } from "../world.js";
import type { IsTagFields } from "./spawn.js";

/**
 * Slot type of one component in a view: literal `true` for tags, the mutable
 * fields record otherwise.
 */
export type ViewSlotValue<P> =
  IsTagFields<ComponentFields<P>> extends true ? true : ComponentFields<P>;

/**
 * The view object passed to the each() callback: an `id` accessor plus one
 * slot per component on the archetype, typed from the storage's registered
 * archetype (untyped accessor record for a bare `Storage`). Data components
 * read as mutable field records and required tags as literal `true`;
 * optional slots additionally read `undefined` while disabled (data) or in
 * place of `true` (tags), narrowing through truthiness.
 *
 * Views are ephemeral: they are rebound per row and must not be stored — the
 * ID is the durable handle for anything outliving the callback.
 */
export type EachView<A extends ArchetypeDescriptor = ArchetypeDescriptor> = {
  /** The entity ID of the current row being iterated (archetype-branded). */
  readonly id: EntityId<A>;
} & (ArchetypeDescriptor extends A
  ? { readonly [key: string]: unknown }
  : { [P in ComponentsOf<A>[number] as ComponentName<P>]: ViewSlotValue<P> } & {
      readonly [P in OptionalsOf<A>[number] as ComponentName<P>]: ViewSlotValue<P> | undefined;
    });

/**
 * Distributes EachView over a union of Storage types.
 * For a single Storage<A>, returns EachView<A>.
 * For a union Storage<A> | Storage<B>, returns EachView<A> | EachView<B>,
 * which only provides access to properties common to all views.
 */
export type EachViewOf<S extends Storage> = S extends Storage<infer A> ? EachView<A> : never;

/** Property lookup that yields `unknown` for keys absent from the view. */
type PropertyOf<T, K extends PropertyKey> = K extends keyof T ? T[K] : unknown;

/**
 * Shapes a view type by a filter: `all` members are promoted (the
 * `undefined` arm removed), `none` members are removed from the view
 * entirely, and `any` members stay optional. A bare component array is
 * shorthand for `{all}`. Distributive over view unions.
 */
export type ViewApplyFilter<V, F> = F extends readonly ComponentDescriptor[]
  ? ViewApplyFilterImpl<V, F[number], never>
  : ViewApplyFilterImpl<
      V,
      F extends { readonly all: readonly (infer All extends ComponentDescriptor)[] } ? All : never,
      F extends { readonly none: readonly (infer None extends ComponentDescriptor)[] }
        ? None
        : never
    >;

/** All-axis component union of a filter (array shorthand included). */
type FilterAllComps<F> = F extends readonly ComponentDescriptor[]
  ? F[number]
  : F extends { readonly all: readonly (infer C extends ComponentDescriptor)[] }
    ? C
    : never;

/** None-axis component union of a filter. */
type FilterNoneComps<F> = F extends {
  readonly none: readonly (infer C extends ComponentDescriptor)[];
}
  ? C
  : never;

/**
 * True when archetype A can possibly match filter F: every all-axis
 * component exists on the archetype (required or optional) and no none-axis
 * component is required. Wide archetypes are never pruned.
 */
type CanMatchFilter<A, F> = ArchetypeDescriptor extends A
  ? true
  : [
        Exclude<
          ComponentName<FilterAllComps<F>>,
          ComponentName<ComponentsOf<A>[number] | OptionalsOf<A>[number]>
        >,
      ] extends [never]
    ? [Extract<ComponentName<FilterNoneComps<F>>, ComponentName<ComponentsOf<A>[number]>>] extends [
        never,
      ]
      ? true
      : false
    : false;

/**
 * Filtered view union for multi-storage iteration: applies the filter to
 * each member's view, pruning members whose archetype cannot match the
 * filter (reachability pruning — mirrors the runtime's per-storage skip).
 */
export type FilteredViewOf<S extends Storage, F> =
  S extends Storage<infer A>
    ? CanMatchFilter<A, F> extends true
      ? ViewApplyFilter<EachView<A>, F>
      : never
    : never;

type PromoteAll<U, All extends ComponentDescriptor> = Omit<U, ComponentName<All>> & {
  [C in All as ComponentName<C>]: Exclude<PropertyOf<U, ComponentName<C>>, undefined>;
};

type ViewApplyFilterImpl<
  V,
  All extends ComponentDescriptor,
  None extends ComponentDescriptor,
> = V extends infer U ? Omit<PromoteAll<U, All>, ComponentName<None>> : never;

/** A generated view paired with its row-index rebinder. */
interface BoundView {
  view: EachView;
  bind: (rowIndex: number) => void;
}

/**
 * Generate a view for a storage: an `id` accessor plus one slot per
 * component — a getter/setter sub-object per data component, literal `true`
 * for required tags, and mask-tested accessors for optionals. Accessors read
 * through the SoA record (not captured column references) so they survive
 * column growth — growth replaces the arrays inside the record.
 *
 * All accessor objects are built eagerly here; the per-row bind swaps only
 * the closed-over row index, so binding allocates nothing.
 */
function buildView(storage: Storage): BoundView {
  let row = 0;
  const view: Record<string, unknown> = {};

  Object.defineProperty(view, "id", {
    get() {
      return storage.entities[row];
    },
  });

  /** Getter/setter record over a data component's columns, sharing `row`. */
  const fieldAccessorsFor = (
    comp: ComponentDescriptor,
    soa: SoAColumns,
  ): Record<string, unknown> => {
    const fieldAccessors: Record<string, unknown> = {};
    for (const fieldName of comp.__ecstatic_fields) {
      // Boolean fields live in Uint8Array columns: encode 1/0, decode !== 0
      const isBoolean = typeof comp.__ecstatic_defaults[fieldName] === "boolean";
      Object.defineProperty(fieldAccessors, fieldName, {
        get: isBoolean ? () => soa[fieldName]![row] !== 0 : () => soa[fieldName]![row],
        set: isBoolean
          ? (value: unknown) => {
              soa[fieldName]![row] = value === true ? 1 : 0;
            }
          : (value: unknown) => {
              soa[fieldName]![row] = value;
            },
      });
    }
    return fieldAccessors;
  };

  for (const comp of storage.archetype.components) {
    if (comp.__ecstatic_fields.length === 0) {
      // Required tag: always present, no columns to accessorize
      view[comp.__ecstatic_name] = true;
      continue;
    }
    // Every required data component has a columns entry (createStorage invariant)
    view[comp.__ecstatic_name] = fieldAccessorsFor(comp, storage.columns.get(comp)!);
  }

  // Optional slots test the row's mask bit on every read, so enable/disable
  // inside an iteration changes what later-bound rows read in the same pass.
  for (const comp of storage.archetype.optionals) {
    const bit = storage.optionalBitLookup.get(comp)!;
    const enabledValue =
      comp.__ecstatic_fields.length === 0
        ? true
        : fieldAccessorsFor(comp, storage.columns.get(comp)!);
    Object.defineProperty(view, comp.__ecstatic_name, {
      get: () => ((storage.mask[row]! & bit) !== 0 ? enabledValue : undefined),
    });
  }

  return {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- opaque type return
    view: view as EachView,
    bind: (rowIndex) => {
      row = rowIndex;
    },
  };
}

/** Per-storage view pool, indexed by nesting depth. */
const viewPools = new WeakMap<Storage, { depth: number; views: BoundView[] }>();

/**
 * Iterate entities in a storage, calling fn once per entity with a view.
 *
 * Iteration runs backward (n−1 down to 0), so despawning the current entity
 * inside the callback is safe and entities spawned mid-pass are not visited.
 *
 * With a filter (`{all}`/`{any}`/`{none}` or a bare component array as
 * `{all}` shorthand), visits exactly the rows whose mask satisfies the
 * triple, reading the matcher's per-row flags — so enabling a matching
 * component on a lower not-yet-visited row makes it visited in the same
 * pass, and disabling makes it skipped. A filter the storage can never
 * satisfy skips the whole storage; a trivially-satisfied filter iterates
 * unfiltered and registers no matcher.
 *
 * Accepts a single storage (or union-typed storage) and storage arrays. For
 * an array, every row of each storage is visited in turn, each storage bound
 * through its own pooled view; with a filter, per-storage resolution applies
 * — a storage that can never match is skipped entirely. The view type is the
 * union over the storages: without a filter only common components are
 * accessible, and with a filter promotion/removal distributes over the
 * union, pruning members whose archetype cannot match the filter.
 *
 * @param storageOrStorages - The storage (or array of storages) to iterate
 * @param filterOrFn - A component filter, or the callback for the unfiltered form
 * @param maybeFn - Callback invoked per entity with the rebound view (filtered form)
 */
export function each<S extends Storage>(storage: S, fn: (view: EachViewOf<S>) => void): void;
export function each<
  S extends Storage,
  const F extends readonly [ComponentDescriptor, ...ComponentDescriptor[]] | EachFilter,
>(storage: S, filter: F, fn: (view: ViewApplyFilter<EachViewOf<S>, F>) => void): void;
export function each<Storages extends readonly Storage[]>(
  storages: [...Storages],
  fn: (view: EachViewOf<Storages[number]>) => void,
): void;
export function each<
  Storages extends readonly Storage[],
  const F extends readonly [ComponentDescriptor, ...ComponentDescriptor[]] | EachFilter,
>(
  storages: [...Storages],
  filter: F,
  fn: (view: FilteredViewOf<Storages[number], F>) => void,
): void;
export function each(
  storageOrStorages: Storage | readonly Storage[],
  filterOrFn: readonly ComponentDescriptor[] | EachFilter | ((view: EachView) => void),
  maybeFn?: (view: EachView) => void,
): void {
  // Arg2-is-function short-circuit: the unfiltered fast path pays only this
  // typeof test.
  let fn: (view: EachView) => void;
  let filterArg: readonly ComponentDescriptor[] | EachFilter | null = null;
  if (typeof filterOrFn === "function") {
    fn = filterOrFn;
  } else {
    // oxlint-disable-next-line typescript/no-unnecessary-condition -- guards untyped callers: typeof null is "object"
    if (typeof filterOrFn !== "object" || filterOrFn === null || typeof maybeFn !== "function") {
      throw new Error("invalid each arguments");
    }
    fn = maybeFn;
    filterArg = filterOrFn;
  }

  if (Array.isArray(storageOrStorages)) {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Array.isArray does not narrow readonly arrays
    for (const storage of storageOrStorages as readonly Storage[]) {
      eachStorage(storage, filterArg, fn);
    }
    return;
  }
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- non-array narrows to the single storage
  eachStorage(storageOrStorages as Storage, filterArg, fn);
}

function eachStorage(
  storage: Storage,
  filterArg: readonly ComponentDescriptor[] | EachFilter | null,
  fn: (view: EachView) => void,
): void {
  let matcher: Matcher | null = null;
  if (filterArg !== null) {
    const resolved = resolveFilter(storage, filterArg);
    if (resolved === false) {
      return;
    }
    matcher = resolved;
  }

  eachStorageMatched(storage, matcher, fn);
}

/**
 * Iterate one storage against an already-resolved matcher (`null` or the
 * trivial matcher iterate unfiltered). Shared by `each` and `query` — query
 * passes matchers from its per-world resolution cache.
 */
export function eachStorageMatched(
  storage: Storage,
  matcher: Matcher | null,
  fn: (view: EachView) => void,
): void {
  // A trivial matcher (all masks zero) iterates unfiltered.
  const activeMatcher =
    matcher !== null && (matcher.allMask !== 0 || matcher.anyMask !== 0 || matcher.noneMask !== 0)
      ? matcher
      : null;

  if (storage.n === 0) {
    return;
  }

  let pool = viewPools.get(storage);
  if (pool === undefined) {
    pool = { depth: 0, views: [] };
    viewPools.set(storage, pool);
  }

  let bound = pool.views[pool.depth];
  if (bound === undefined) {
    bound = buildView(storage);
    pool.views.push(bound);
  }

  pool.depth++;
  try {
    if (activeMatcher === null) {
      for (let i = storage.n - 1; i >= 0; i--) {
        bound.bind(i);
        fn(bound.view);
      }
    } else {
      // Read matched through the matcher each row: growth replaces the
      // array, and a callback that spawns past capacity must not detach the
      // in-flight pass from later same-pass enable/disable updates.
      for (let i = storage.n - 1; i >= 0; i--) {
        if (activeMatcher.matched[i] !== 0) {
          bound.bind(i);
          fn(bound.view);
        }
      }
    }
  } finally {
    pool.depth--;
  }
}
