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

import type { ArchetypeDescriptor, ComponentsOf } from "../archetype.js";
import type { ComponentFields, ComponentName } from "../component.js";
import type { EntityId } from "../entity-id.js";
import type { Storage } from "../world.js";

/**
 * The view object passed to the each() callback: an `id` accessor plus one
 * mutable field record per component on the archetype, typed from the
 * storage's registered archetype (untyped accessor record for a bare
 * `Storage`).
 *
 * Views are ephemeral: they are rebound per row and must not be stored — the
 * ID is the durable handle for anything outliving the callback.
 */
export type EachView<A extends ArchetypeDescriptor = ArchetypeDescriptor> = {
  /** The entity ID of the current row being iterated. */
  readonly id: EntityId;
} & (ArchetypeDescriptor extends A
  ? { readonly [key: string]: unknown }
  : { [P in ComponentsOf<A>[number] as ComponentName<P>]: ComponentFields<P> });

/**
 * Distributes EachView over a union of Storage types.
 * For a single Storage<A>, returns EachView<A>.
 * For a union Storage<A> | Storage<B>, returns EachView<A> | EachView<B>,
 * which only provides access to properties common to all views.
 */
export type EachViewOf<S extends Storage> = S extends Storage<infer A> ? EachView<A> : never;

/** A generated view paired with its row-index rebinder. */
interface BoundView {
  view: EachView;
  bind: (rowIndex: number) => void;
}

/**
 * Generate a view for a storage: an `id` accessor plus one sub-object per
 * component with a getter/setter per field. Accessors read through the SoA
 * record (not captured column references) so they survive column growth —
 * growth replaces the arrays inside the record.
 */
function buildView(storage: Storage): BoundView {
  let row = 0;
  const view: Record<string, unknown> = {};

  Object.defineProperty(view, "id", {
    get() {
      return storage.entities[row];
    },
  });

  for (const comp of storage.archetype.components) {
    // Every required component has a columns entry (createStorage invariant)
    const soa = storage.columns.get(comp)!;
    const sub: Record<string, unknown> = {};

    for (const fieldName of comp.__ecstatic_fields) {
      // Boolean fields live in Uint8Array columns: encode 1/0, decode !== 0
      const isBoolean = typeof comp.__ecstatic_defaults[fieldName] === "boolean";
      Object.defineProperty(sub, fieldName, {
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

    view[comp.__ecstatic_name] = sub;
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
 * Accepts both single storages and unions of storages. When passed a union,
 * the view type is the union of per-archetype views, providing type-safe access
 * to only components present on all archetypes in the union.
 *
 * @param storage - The storage (or union of storages) to iterate
 * @param fn - Callback invoked per entity with the rebound view
 */
export function each<S extends Storage>(storage: S, fn: (view: EachViewOf<S>) => void): void;
export function each(storage: Storage, fn: (view: EachView) => void): void {
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
    for (let i = storage.n - 1; i >= 0; i--) {
      bound.bind(i);
      fn(bound.view);
    }
  } finally {
    pool.depth--;
  }
}
