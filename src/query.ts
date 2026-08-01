/**
 * Cross-archetype query: iterate matching rows across every registered
 * archetype that carries the filter's `all` components (as required columns
 * or enabled optionals, per filter semantics).
 *
 * Resolution — which storages match and with which matcher — is cached per
 * (filter object, world) pair: a module-level WeakMap keyed by the filter's
 * identity holds one entry per world, validated against the world's
 * `queryEpoch` (bumped by `register`/`destroyWorld`). Matched-row flags live
 * on the matchers and update in place as entities change, so a cached
 * resolution stays correct until the archetype set itself changes. Hoist the
 * filter object to benefit from the cache; a fresh literal per call
 * re-resolves every time.
 */

import type { ComponentDescriptor, ComponentName } from "./component.js";
import type { EntityId } from "./entity-id.js";
import type { EachView, ViewSlotValue } from "./entity/each.js";
import { eachStorageMatched } from "./entity/each.js";
import { ERROR_QUERY_EMPTY } from "./errors.js";
import { findArchetypes, normalizeFilter, resolveFilterMasks } from "./filter.js";
import type { Matcher } from "./matcher.js";
import type { Storage, World, WorldState } from "./world.js";

/**
 * Synthetic view type for query callbacks: required slots from the `all`
 * axis (tags as literal `true`), optional truthiness-narrowed slots from the
 * `any` axis; `none` components never appear.
 */
export type QueryView<All extends ComponentDescriptor, Any extends ComponentDescriptor = never> = {
  readonly id: EntityId;
} & { [P in All as ComponentName<P>]: ViewSlotValue<P> } & {
  readonly [P in Any as ComponentName<P>]: ViewSlotValue<P> | undefined;
};

/** Per-world resolution of one filter object, valid while the epoch matches. */
interface ResolvedQuery {
  epoch: number;
  storages: Storage[];
  matchers: Matcher[];
}

/** Filter-object identity → per-world cached resolutions. */
const QUERY_CACHE = new WeakMap<object, WeakMap<WorldState, ResolvedQuery>>();

/**
 * Resolve (or reuse) the matching storages and matchers for a filter object
 * against a world. Stale entries (epoch mismatch after `register`/
 * `destroyWorld`) are re-resolved and replace the cached entry.
 */
function resolveQuery(
  state: WorldState,
  target: object,
  allIds: readonly ComponentDescriptor[],
  anyIds: readonly ComponentDescriptor[],
  noneIds: readonly ComponentDescriptor[],
): ResolvedQuery {
  let perWorld = QUERY_CACHE.get(target);
  if (perWorld === undefined) {
    perWorld = new WeakMap();
    QUERY_CACHE.set(target, perWorld);
  }
  const cached = perWorld.get(state);
  if (cached !== undefined && cached.epoch === state.queryEpoch) {
    return cached;
  }

  const storages: Storage[] = [];
  const matchers: Matcher[] = [];
  for (const storage of findArchetypes(state, allIds)) {
    const matcher = resolveFilterMasks(storage, allIds, anyIds, noneIds);
    if (matcher === false) {
      continue;
    }
    storages.push(storage);
    matchers.push(matcher);
  }

  const resolved: ResolvedQuery = { epoch: state.queryEpoch, storages, matchers };
  perWorld.set(state, resolved);
  return resolved;
}

/**
 * Iterate matching rows across every registered archetype that carries all
 * listed components. The comps-array form is `{all}` shorthand; the filter
 * form takes `{all, any?, none?}` where `all` is required and non-empty
 * (unlike `each`, whose axes are all optional). Archetypes that can never
 * match and empty storages are skipped; iteration within each storage is
 * reverse, so despawning the current entity is safe.
 *
 * @throws If the `all` axis (or comps array) is empty
 */
export function query<const Comps extends readonly [ComponentDescriptor, ...ComponentDescriptor[]]>(
  world: World,
  comps: readonly [...Comps],
  fn: (view: QueryView<Comps[number]>) => void,
): void;
export function query<
  const All extends readonly [ComponentDescriptor, ...ComponentDescriptor[]],
  const Any extends readonly ComponentDescriptor[] = readonly [],
>(
  world: World,
  filter: {
    readonly all: readonly [...All];
    readonly any?: readonly [...Any];
    readonly none?: readonly ComponentDescriptor[];
    readonly __ecstatic_name?: never;
  },
  fn: (view: QueryView<All[number], Any[number]>) => void,
): void;
export function query(
  world: World,
  // Structurally widened from QueryFilter so the generic overloads' spread
  // tuples stay provably assignable; the overloads enforce non-emptiness.
  target:
    | readonly ComponentDescriptor[]
    | {
        readonly all: readonly ComponentDescriptor[];
        readonly any?: readonly ComponentDescriptor[];
        readonly none?: readonly ComponentDescriptor[];
      },
  fn: unknown,
): void {
  if (typeof fn !== "function") {
    throw new Error("invalid query callback");
  }
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the overloads type fn as a view callback; runtime views are EachView objects
  const callback = fn as (view: EachView) => void;

  const state: WorldState = world;

  const [allIds, anyIds, noneIds] = normalizeFilter(target);

  if (allIds.length === 0) {
    throw new Error(ERROR_QUERY_EMPTY);
  }

  const resolved = resolveQuery(state, target, allIds, anyIds, noneIds);
  const storages = resolved.storages;
  const matchers = resolved.matchers;
  for (let i = 0; i < storages.length; i++) {
    const storage = storages[i]!;
    if (storage.n > 0) {
      eachStorageMatched(storage, matchers[i]!, callback);
    }
  }
}
