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
import type { FieldColumn, Storage } from "../world.js";
import type { IsTagFields } from "./spawn.js";

/**
 * Slot type of one component in a view: literal `true` for tags, the mutable
 * fields record otherwise. A relation exposes only its data fields — the
 * `target` column is not accessorized (read it with `getTarget`, write it
 * with `link`), so a pure link types as a tag slot.
 */
export type ViewSlotValue<P> = P extends {
  readonly __ecstatic_relation_meta: { fields: infer T extends object };
}
  ? IsTagFields<T> extends true
    ? true
    : T
  : IsTagFields<ComponentFields<P>> extends true
    ? true
    : ComponentFields<P>;

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

/**
 * The empty-axis checks are display-driven: `Omit<V, never>` and `& {}` are
 * structural no-ops, but they survive into editor hovers — skipping them keeps
 * a one-axis filter's view printing as a single Omit/intersection.
 */
type PromoteAll<U, All extends ComponentDescriptor> = [All] extends [never]
  ? U
  : Omit<U, ComponentName<All>> & {
      [C in All as ComponentName<C>]: Exclude<PropertyOf<U, ComponentName<C>>, undefined>;
    };

type ViewApplyFilterImpl<
  V,
  All extends ComponentDescriptor,
  None extends ComponentDescriptor,
> = V extends infer U
  ? [None] extends [never]
    ? PromoteAll<U, All>
    : Omit<PromoteAll<U, All>, ComponentName<None>>
  : never;

/** A generated view paired with its row-index rebinder. */
export interface BoundView {
  view: EachView;
  bind: (rowIndex: number) => void;
}

/**
 * Create an empty plain object on a hidden-class root no other object shares.
 *
 * The view and its field records each carry accessors with their own
 * getter/setter closures. Objects grown from `{}` share one transition tree,
 * where a key can map to only one accessor pair — so the second object to
 * define an already-used key with different closures (every view's `id`,
 * every component with a field named like another's) would drop to dictionary
 * mode. Rooting each object at its own class keeps all of them in fast mode;
 * resetting the prototype keeps them indistinguishable from `{}` literals.
 *
 * @returns A fresh, empty object whose prototype is `Object.prototype`.
 */
function newAccessorHost(): Record<string, unknown> {
  // Declared per call on purpose: every class gets its own root hidden class.
  class AccessorHost {
    [key: string]: unknown;
  }
  const host = new AccessorHost();
  Object.setPrototypeOf(host, Object.prototype);
  return host;
}

/**
 * Generate a view for a storage: an `id` accessor plus one slot per
 * component — a getter/setter sub-object per data component, literal `true`
 * for required tags, and mask-tested accessors for optionals. Accessors read
 * through the storage's field columns (not captured arrays) so they survive
 * column growth — growth points the same field columns at the new arrays.
 *
 * Every accessor is enumerable, so `Object.keys`, spread, and `JSON.stringify`
 * see `id`, each component slot, and each data component's fields. Spreading
 * or serializing runs the getters, so the result is a snapshot of the bound
 * row: boolean fields come out as `true`/`false`, and a disabled optional
 * reads `undefined`, which `JSON.stringify` omits.
 *
 * All accessor objects are built eagerly here; the per-row bind swaps only
 * the closed-over row index, so binding allocates nothing.
 *
 * @param storage - Storage whose archetype and field columns the accessors close
 *   over; the view is tied to this one storage for its whole lifetime.
 * @returns A newly allocated view and its rebinder, owned by the per-storage
 *   pool; the view reads an arbitrary row until `bind` has been called.
 * @throws If a data component has no field columns or an optional has no
 *   presence bit (invariant guards, unreachable)
 */
function buildView(storage: Storage): BoundView {
  let row = 0;
  const view = newAccessorHost();

  Object.defineProperty(view, "id", {
    enumerable: true,
    get() {
      return storage.entities[row];
    },
  });

  /**
   * Getter/setter record over a data component's columns, sharing `row`.
   *
   * @param comp - Data component whose declared fields become accessors;
   *   boolean fields are decoded from their 0/1 Uint8Array encoding.
   * @param columns - The storage's field columns for `comp`, read through on
   *   every access rather than capturing the arrays, so the accessors survive
   *   column growth.
   * @returns One accessor per field, reading and writing whichever row the
   *   enclosing view is currently bound to.
   */
  const fieldAccessorsFor = (
    comp: ComponentDescriptor,
    columns: readonly FieldColumn[],
  ): Record<string, unknown> => {
    const fieldAccessors = newAccessorHost();
    for (const column of columns) {
      // Boolean fields live in Uint8Array columns: encode 1/0, decode !== 0
      const isBoolean = typeof comp.__ecstatic_defaults[column.field] === "boolean";
      Object.defineProperty(fieldAccessors, column.field, {
        enumerable: true,
        get: isBoolean ? () => column.array[row] !== 0 : () => column.array[row],
        set: isBoolean
          ? (value: unknown) => {
              column.array[row] = value === true ? 1 : 0;
            }
          : (value: unknown) => {
              column.array[row] = value;
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
    // Every required data component has field columns (createStorage invariant)
    const columns = storage.fieldColumns.get(comp);
    /* istanbul ignore next */
    if (columns === undefined) throw new Error("invariant: missing columns for required component");
    view[comp.__ecstatic_name] = fieldAccessorsFor(comp, columns);
  }

  // Optional slots test the row's mask bit on every read, so enable/disable
  // inside an iteration changes what later-bound rows read in the same pass.
  for (const comp of storage.archetype.optionals) {
    const bit = storage.optionalBitLookup.get(comp);
    /* istanbul ignore next */
    if (bit === undefined) throw new Error("invariant: optional missing from bitLookup");
    const optColumns = storage.fieldColumns.get(comp);
    const enabledValue =
      comp.__ecstatic_fields.length === 0 || optColumns === undefined
        ? true
        : fieldAccessorsFor(comp, optColumns);
    Object.defineProperty(view, comp.__ecstatic_name, {
      enumerable: true,
      // oxlint-disable-next-line typescript/no-non-null-assertion -- mask[row] is guaranteed present: row is always a valid dense index maintained by acquireView/bind
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
 * Check out the storage's pooled view for the current nesting depth,
 * building it on first use. Every acquire must be paired with a
 * {@link releaseView} (in a `finally`, so a throwing callback unwinds the
 * depth) — nested iterations over the same storage get distinct views.
 *
 * @param storage - Storage to iterate; its pool is created on first use and
 *   keyed by storage identity.
 * @returns The pooled view for the current nesting depth, shared with every
 *   other iteration at that depth, so it must not be retained past the
 *   matching release.
 */
export function acquireView(storage: Storage): BoundView {
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
  return bound;
}

/**
 * Return a view checked out by {@link acquireView} to the storage's pool.
 *
 * @param storage - The same storage passed to the paired acquire; only that
 *   storage's nesting depth is decremented.
 */
export function releaseView(storage: Storage): void {
  const pool = viewPools.get(storage);
  /* istanbul ignore next */
  if (pool === undefined) throw new Error("invariant: releaseView without prior acquireView");
  pool.depth--;
}

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
 * @param storage - A storage, union-typed storage, or array of storages; each
 *   storage is walked from its last row down to row 0 through its own pooled
 *   view.
 * @param filter - Optional second argument of the filtered overloads: a bare
 *   component array (shorthand for {all}) or an {all}/{any}/{none} filter;
 *   only rows whose mask satisfies it are visited.
 * @param fn - Called once per visited entity with the storage's pooled view
 *   rebound in place; the same object is passed on every call, so keep the
 *   `id` rather than the view for anything outliving the callback.
 * @throws If the filtered form is called without a callback (reachable only
 *   past the overload types).
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
      throwInvalidEachArguments();
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

/**
 * Throws the error `each` throws for arguments it cannot read as a storage, a filter, and a
 * callback, so code generated for an inlined call throws the same error without naming a global.
 *
 * @throws Error saying the `each` arguments are invalid, always.
 */
export function throwInvalidEachArguments(): never {
  throw new Error("invalid each arguments");
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
 * trivial matcher iterate unfiltered).
 *
 * @param storage - Storage to walk; an empty storage returns before any view
 *   is acquired.
 * @param matcher - Resolved matcher whose per-row `matched` flags gate each
 *   visit, read live so a same-pass enable or disable changes which
 *   not-yet-visited rows are seen; `null` or an all-zero-mask matcher visits
 *   every row.
 * @param fn - Called once per visited row, from the last row down to row 0,
 *   with the storage's pooled view rebound in place; the same object is
 *   reused across calls and must not be retained.
 * @throws Whatever `fn` throws; the pooled view is released first.
 */
export function eachStorageMatched(
  storage: Storage,
  matcher: Matcher | null,
  fn: (view: EachView) => void,
): void {
  const activeMatcher =
    matcher !== null && (matcher.allMask !== 0 || matcher.anyMask !== 0 || matcher.noneMask !== 0)
      ? matcher
      : null;

  if (storage.n === 0) {
    return;
  }

  const bound = acquireView(storage);
  try {
    if (activeMatcher === null) {
      for (let i = storage.n - 1; i >= 0; i--) {
        bound.bind(i);
        fn(bound.view);
      }
      return;
    }
    // Read matched through the matcher each row: growth replaces the
    // array, and a callback that spawns past capacity must not detach the
    // in-flight pass from later same-pass enable/disable updates.
    for (let i = storage.n - 1; i >= 0; i--) {
      if (activeMatcher.matched[i] !== 0) {
        bound.bind(i);
        fn(bound.view);
      }
    }
  } finally {
    releaseView(storage);
  }
}
