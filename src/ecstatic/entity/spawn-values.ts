/**
 * Component override reads and writes for spawn: read every non-relation
 * override value onto the held stack before allocation, then write the held
 * values into the committed rows.
 *
 * Every function here is internal to the spawn path and not part of the
 * public API.
 */

import { errorRequiredDisabled } from "../errors.js";
import { getRelationMeta } from "../relation.js";
import type { Storage } from "../world.js";
import {
  heldTop,
  heldValue,
  hold,
  holdBirthValues,
  holdFieldValues,
  releaseHeld,
  writeHeldFields,
} from "./held.js";
import { readBirthTargets } from "./spawn-link.js";
import type { SpawnOverrides } from "./spawn.js";

/** Frame of a spawn without overrides: nothing is held. */
const NO_FRAME = -1;

/**
 * Read every override of a spawn once, before any row exists: the field values of the required
 * components' records, then those of the optional components' records followed by the enabled
 * optionals' presence bits, all onto the held stack, and last the relation overrides through
 * `readBirthTargets`, which keeps its own stack. {@link writeHeldOverrides} writes the frame
 * this returns.
 *
 * Without overrides no user code can run: nothing is held and only the relation targets are
 * read.
 *
 * @param storage - Storage being spawned into; its archetype decides which overrides are read.
 * @param overrides - Spawn overrides keyed by component name; `undefined` means defaults
 *   everywhere with no optional enabled.
 * @returns The frame to pass to {@link writeHeldOverrides}.
 * @throws If an override sets a required component to `false`
 * @throws Whatever `readBirthTargets` throws
 * @throws Whatever a getter on `overrides` throws; nothing is left held
 */
export function holdSpawnOverrides(
  storage: Storage,
  overrides: SpawnOverrides | undefined,
): number {
  if (overrides === undefined) {
    if (storage.relationN > 0) {
      readBirthTargets(storage, undefined);
    }
    return NO_FRAME;
  }
  const frame = heldTop();
  try {
    holdRequiredOverrides(storage, overrides);
    hold(holdOptionalOverrides(storage, overrides));
    if (storage.relationN > 0) {
      readBirthTargets(storage, overrides);
    }
  } catch (error) {
    releaseHeld(frame);
    throw error;
  }
  return frame;
}

/**
 * Hold the birth values of every required non-relation component: its override record's
 * values, else its defaults. Required relations are left to `readBirthTargets`.
 *
 * @param storage - Storage whose archetype's required components are read, in declaration order.
 * @param overrides - Spawn overrides keyed by component name.
 * @throws If an override sets a required component to `false`
 * @throws Whatever a getter on `overrides` throws
 */
function holdRequiredOverrides(storage: Storage, overrides: SpawnOverrides): void {
  for (const comp of storage.archetype.components) {
    if (getRelationMeta(comp) !== undefined) {
      continue;
    }
    holdBirthValues(storage, comp, resolveRequiredOverride(comp.__ecstatic_name, overrides));
  }
}

/**
 * Hold the field values of every non-relation optional's override record. `true` enables with
 * the defaults, a record enables and patches the listed fields, `false` or absent stays
 * disabled.
 *
 * Iterates the archetype's optionals, so unknown override keys are silently ignored (the types
 * reject them) — unlike `enable`, whose record form throws on unknown names at runtime. Optional
 * relations are left to `readBirthTargets`.
 *
 * @param storage - Storage whose optionals are read and whose `optionalBitLookup` supplies each
 *   enabled component's bit.
 * @param overrides - Spawn overrides keyed by component name.
 * @returns The OR of the presence bits of every enabled non-relation optional.
 * @throws Whatever a getter on `overrides` throws
 */
function holdOptionalOverrides(storage: Storage, overrides: SpawnOverrides): number {
  let bits = 0;
  for (const comp of storage.archetype.optionals) {
    if (getRelationMeta(comp) !== undefined) {
      continue;
    }
    const raw = overrides[comp.__ecstatic_name];
    if (raw === undefined || raw === false) {
      continue;
    }
    // oxlint-disable-next-line typescript/no-non-null-assertion -- comp is an optional on the archetype, so bit is registered
    bits |= storage.optionalBitLookup.get(comp)!;
    if (raw !== true) {
      holdFieldValues(storage, comp, raw);
    }
  }
  return bits;
}

/**
 * Write the frame {@link holdSpawnOverrides} returned into the freshly spawned rows
 * `[denseStart, storage.n)`, or the required components' defaults when there is no frame, and
 * release the frame. Runs
 * no user code, so the rows stay valid for the whole write.
 *
 * @param storage - Storage the rows were spawned into; `writeOptionalDefaults` must already have
 *   run so it does not overwrite the patches written here.
 * @param denseStart - First dense row of the run; the run ends at `storage.n`, already advanced
 *   past it with the arrays grown. Every row gets the same values.
 * @param frame - What `holdSpawnOverrides` returned for this spawn.
 * @returns The OR of the presence bits of every enabled non-relation optional; the caller merges
 *   in the relation bits and writes the mask to `storage.mask`, this function does not.
 */
export function writeHeldOverrides(storage: Storage, denseStart: number, frame: number): number {
  const count = storage.n - denseStart;
  if (frame === NO_FRAME) {
    writeRequiredDefaults(storage, denseStart, count);
    return 0;
  }
  const bitsSlot = heldTop() - 1;
  writeHeldFields(frame, bitsSlot, denseStart, count);
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- holdSpawnOverrides holds the presence bits last
  const bits = heldValue(bitsSlot) as number;
  releaseHeld(frame);
  return bits;
}

/**
 * Write every required non-relation component's declared defaults into a run of rows. Ref
 * fields stay as despawn left them, cleared. Required relations are skipped:
 * `writeBirthRelations` owns them.
 *
 * @param storage - Storage the rows were spawned into.
 * @param denseStart - First dense row of the run.
 * @param count - Number of consecutive rows written.
 */
function writeRequiredDefaults(storage: Storage, denseStart: number, count: number): void {
  for (const comp of storage.archetype.components) {
    if (getRelationMeta(comp) !== undefined) {
      continue;
    }
    const columns = storage.fieldColumns.get(comp);
    if (columns === undefined) {
      continue;
    }
    const defaultValues = comp.__ecstatic_default_values;
    const isRef = comp.__ecstatic_is_reference;
    for (let fieldIdx = 0; fieldIdx < columns.length; fieldIdx++) {
      if (isRef[fieldIdx] !== true) {
        // oxlint-disable-next-line typescript/no-non-null-assertion -- fieldIdx < columns.length
        fillRange(columns[fieldIdx]!.array, denseStart, count, defaultValues[fieldIdx]);
      }
    }
  }
}

function fillRange(
  col: { [i: number]: unknown },
  start: number,
  count: number,
  value: unknown,
): void {
  for (let i = 0; i < count; i++) {
    col[start + i] = value;
  }
}

/**
 * Resolve a required component's spawn override.
 *
 * @param name - The component's declared name, the key looked up in `overrides`.
 * @param overrides - Spawn overrides record.
 * @returns The field record to patch on top of defaults, or `undefined` when the component takes
 *   its defaults (`true` or absent).
 * @throws If the override is `false` — required components cannot be disabled at spawn.
 */
function resolveRequiredOverride(
  name: string,
  overrides: SpawnOverrides,
): Record<string, unknown> | undefined {
  const raw = overrides[name];
  if (raw === undefined || raw === true) {
    return undefined;
  }
  if (raw === false) {
    throw new Error(errorRequiredDisabled(name));
  }
  return raw;
}
