/**
 * Relation birth-link helpers for spawn: validate relation targets before
 * allocation and record reverse-map entries after the row is committed.
 *
 * Every function here is internal to the spawn path and not part of the
 * public API.
 */

import type { ComponentDescriptor } from "../component.js";
import { entityIndex } from "../entity-id.js";
import {
  errorOptionalRelationTarget,
  errorRequiredRelationTarget,
  errorStaleTarget,
} from "../errors.js";
import type { SoAColumns, Storage, WorldState } from "../world.js";
import type { ReverseCtx } from "./reverse-map.js";
import { reverseInsert } from "./reverse-map.js";
import type { SpawnOverrides } from "./spawn.js";

/**
 * Validate every relation birth-link target in `overrides` before a row exists
 * (DEBUG-gated at the call sites).
 *
 * Running ahead of allocation is what makes a rejected checked-mode spawn
 * atomic. The write path commits `storage.n`, `entityArch`, the presence mask,
 * the target column, the matcher flags, and reverse-map entries with no unwind,
 * so a throw from inside it leaves a half-spawned row that `each` still visits
 * and that a matcher can match on a recycled row's stale presence bit. Every
 * value-dependent relation check belongs here, never in the write path.
 *
 * `relationDescriptors` lists required relations before optionals, so errors
 * surface in archetype declaration order.
 */
export function assertRelationTargets(
  storage: Storage,
  overrides: SpawnOverrides | undefined,
): void {
  const relN = storage.relationN;
  for (let ri = 0; ri < relN; ri++) {
    // oxlint-disable-next-line typescript/no-non-null-assertion -- ri < relN ≤ relationDescriptors.length
    const name = storage.relationDescriptors[ri]!.__ecstatic_name;
    const optional = storage.relationOptionalBits[ri] !== 0;
    assertRelationTarget(storage.world, name, optional, overrides?.[name]);
  }
}

/**
 * Validate one relation's spawn override value against the birth-link grammar:
 * a required relation must name a live target, an optional one may omit the
 * birth link entirely but cannot name a dead or sentinel target.
 */
function assertRelationTarget(
  state: WorldState,
  name: string,
  optional: boolean,
  raw: Record<string, unknown> | boolean | undefined,
): void {
  // `false` on an optional relation means "stay unlinked"; on a required one
  // resolveRequiredOverride owns the "cannot be disabled" error.
  if (raw === false) {
    return;
  }

  const rawTarget = raw === undefined || raw === true ? undefined : raw.target;
  if (rawTarget === undefined) {
    if (optional) {
      return;
    }
    throw new Error(errorRequiredRelationTarget(name));
  }

  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- override targets are EntityIds (branded numbers)
  const target = rawTarget as number;
  if (target === 0) {
    throw new Error(
      optional ? errorOptionalRelationTarget(name) : errorRequiredRelationTarget(name),
    );
  }
  if (state.generation[entityIndex(target)] !== target) {
    throw new Error(errorStaleTarget(name));
  }
}

export interface SpawnRange {
  storage: Storage;
  denseStart: number;
  count: number;
}

/**
 * Birth-link an optional relation for `count` rows starting at `denseStart`:
 * write the target column and record each source in the target's reverse
 * bucket. Targets are pre-validated by `assertRelationTargets`, so this write
 * path never throws — see that function before adding a check here.
 */
export function birthLinkOptional(
  range: SpawnRange,
  comp: ComponentDescriptor,
  soa: SoAColumns,
  rawTarget: unknown,
): void {
  const { storage, denseStart, count } = range;
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- override targets are EntityIds (branded numbers)
  const target = rawTarget as number;
  // Only reachable under NDEBUG, where the 0 sentinel is unvalidated: leave the
  // sentinel in place so the row spawns unlinked with no reverse entry.
  if (target === 0) {
    return;
  }
  // oxlint-disable-next-line typescript/no-non-null-assertion -- relation SoA always has a target column
  const targetCol = soa.target!;
  const targetIdx = entityIndex(target);
  const reverseCtx: ReverseCtx = { state: storage.world, rel: comp };
  for (let i = 0; i < count; i++) {
    const di = denseStart + i;
    targetCol[di] = target;
    // oxlint-disable-next-line typescript/no-non-null-assertion -- di is a freshly spawned dense index
    reverseInsert(reverseCtx, targetIdx, storage, entityIndex(storage.entities[di]!));
  }
}

/**
 * Record reverse-map entries for the required relations of `count` freshly
 * spawned rows, reading targets from the already-initialized target columns.
 *
 * Target presence (0 = not provided) and liveness are validated by
 * `assertRelationTargets` before the row exists — a stale target would seed a
 * reverse entry that aliases onto a reused slot. Under NDEBUG both checks are
 * absent: the entity spawns unlinked on a 0 target, and no reverse entry is
 * recorded.
 */
export function insertRequiredRelationEntries(
  storage: Storage,
  denseStart: number,
  count: number,
): void {
  const state = storage.world;
  const relCols = storage.relationTargetColumns;
  const relDescriptors = storage.relationDescriptors;
  const relBits = storage.relationOptionalBits;
  const relN = storage.relationN;

  for (let ri = 0; ri < relN; ri++) {
    if (relBits[ri] !== 0) {
      continue;
    }
    // oxlint-disable-next-line typescript/no-non-null-assertion -- ri < relN ≤ relCols.length
    const col = relCols[ri]!;
    // oxlint-disable-next-line typescript/no-non-null-assertion -- ri < relN ≤ relDescriptors.length
    const relDesc = relDescriptors[ri]!;
    const entryCtx: RequiredEntryCtx = { state, storage, rel: relDesc };
    for (let i = 0; i < count; i++) {
      const di = denseStart + i;
      // oxlint-disable-next-line typescript/no-non-null-assertion -- di is a freshly spawned dense index
      insertRequiredEntry(entryCtx, col[di]!, di);
    }
  }
}

interface RequiredEntryCtx {
  state: WorldState;
  storage: Storage;
  rel: ComponentDescriptor;
}

/**
 * Record one required-relation birth entry. A 0 target means "not provided",
 * only reachable under NDEBUG, where the entity is left unlinked with no
 * reverse entry.
 */
function insertRequiredEntry(ctx: RequiredEntryCtx, target: number, di: number): void {
  if (target === 0) {
    return;
  }
  // oxlint-disable-next-line typescript/no-non-null-assertion -- di is a freshly spawned dense index
  reverseInsert(ctx, entityIndex(target), ctx.storage, entityIndex(ctx.storage.entities[di]!));
}
