/**
 * The `iteration/throughput` and `iteration/frame` systems and their inlined
 * twins, each defined once.
 *
 * Every `each()` system here has an inlined twin: the column loop a build-time
 * optimizer would emit for that `each()` call. The `reference/` suite times
 * the twins, the `iteration/` suite times the `each()` bodies, and the
 * equivalence test runs both over identical worlds, so what is timed is
 * exactly what is proven equivalent.
 *
 * An inlined twin calls none of `each`, `query`, `get` or `set`. It reads its
 * column arrays from `storage.columns` at the start of every call, because
 * growth replaces a storage's typed columns and the optimized code reads
 * that same state, then walks rows from `storage.n - 1` down to 0, the order
 * `each` visits them.
 *
 * Every body accumulates `DT`, or a field it never writes times `DT`, into a
 * field it writes. mitata replays a batched body many thousands of times, and
 * that shape keeps every value finite and normal however long it runs, so
 * neither variant slows down on subnormal arithmetic.
 */

import { each, type Storage } from "ecstatic";

import {
  Armor,
  CompA,
  CompB,
  CompC,
  CompD,
  CompE,
  F1,
  F2,
  F5,
  F10,
  Health,
  Position,
  Velocity,
  type bgArch,
  type chainArch,
  type soa1Arch,
  type soa2Arch,
  type soa5Arch,
  type soa10Arch,
  type spawnArch,
  type tagArch,
  type trackedArch,
} from "./archetypes.js";
import { DT, type FrameCtx } from "./helpers.js";

/** A component descriptor, as `storage.columns` keys it. */
type ColumnOwner = Parameters<Storage["columns"]["get"]>[0];

/**
 * Look up the column an inlined body reads and writes.
 *
 * @param storage - Storage holding the column.
 * @param component - Component the field belongs to.
 * @param field - Field name within `component`.
 * @returns The storage's current column for the field.
 * @throws TypeError when `storage` has no such column, or the column is not a `Float64Array`: every
 * field the systems touch is a plain number, so anything else means the archetypes changed.
 */
function f64Column(storage: Storage, component: ColumnOwner, field: string): Float64Array {
  const column = storage.columns.get(component)?.[field];
  if (!(column instanceof Float64Array)) {
    throw new TypeError(`storage ${String(storage.id)} has no Float64Array column for '${field}'`);
  }
  return column;
}

// ---------------------------------------------------------------------------
// Systems
// ---------------------------------------------------------------------------

/**
 * The `iteration/throughput` body: integrate `Position` by `Velocity` over one `DT`.
 *
 * @param storage - Storage to integrate, every row of it.
 */
export function throughputEach(storage: Storage<typeof trackedArch>): void {
  each(storage, (e) => {
    e.Position.x += e.Velocity.dx * DT;
    e.Position.y += e.Velocity.dy * DT;
  });
}

/**
 * Inlined twin of {@link throughputEach}, mirroring its `each` call as one column loop.
 *
 * @param storage - Storage to integrate, every row of it.
 * @throws TypeError when a column it reads is missing or not a `Float64Array`.
 */
export function throughputInlined(storage: Storage<typeof trackedArch>): void {
  const x = f64Column(storage, Position, "x");
  const y = f64Column(storage, Position, "y");
  const dx = f64Column(storage, Velocity, "dx");
  const dy = f64Column(storage, Velocity, "dy");
  for (let i = storage.n - 1; i >= 0; i--) {
    // oxlint-disable-next-line typescript/no-non-null-assertion -- 0 <= i < n <= column length
    x[i]! += dx[i]! * DT;
    // oxlint-disable-next-line typescript/no-non-null-assertion -- 0 <= i < n <= column length
    y[i]! += dy[i]! * DT;
  }
}

function healEach(storage: Storage<typeof bgArch>): void {
  each(storage, (e) => {
    e.Health.hp += e.Armor.def * DT;
  });
}

/**
 * Inlined twin of `healEach`, mirroring its `each` call as one column loop.
 *
 * @param storage - Storage to update, every row of it.
 * @throws TypeError when a column it reads is missing or not a `Float64Array`.
 */
function healInlined(storage: Storage<typeof bgArch>): void {
  const hp = f64Column(storage, Health, "hp");
  const def = f64Column(storage, Armor, "def");
  for (let i = storage.n - 1; i >= 0; i--) {
    // oxlint-disable-next-line typescript/no-non-null-assertion -- 0 <= i < n <= column length
    hp[i]! += def[i]! * DT;
  }
}

function driftEach(storage: Storage<typeof spawnArch>): void {
  each(storage, (e) => {
    e.Position.x += DT;
  });
}

/**
 * Inlined twin of `driftEach`, mirroring its `each` call as one column loop.
 *
 * @param storage - Storage to update, every row of it.
 * @throws TypeError when a column it reads is missing or not a `Float64Array`.
 */
function driftInlined(storage: Storage<typeof spawnArch>): void {
  const x = f64Column(storage, Position, "x");
  for (let i = storage.n - 1; i >= 0; i--) {
    // oxlint-disable-next-line typescript/no-non-null-assertion -- 0 <= i < n <= column length
    x[i]! += DT;
  }
}

function climbEach(storage: Storage<typeof tagArch>): void {
  each(storage, (e) => {
    e.Position.y += e.Position.x * DT;
  });
}

/**
 * Inlined twin of `climbEach`, mirroring its `each` call as one column loop.
 *
 * @param storage - Storage to update, every row of it.
 * @throws TypeError when a column it reads is missing or not a `Float64Array`.
 */
function climbInlined(storage: Storage<typeof tagArch>): void {
  const x = f64Column(storage, Position, "x");
  const y = f64Column(storage, Position, "y");
  for (let i = storage.n - 1; i >= 0; i--) {
    // oxlint-disable-next-line typescript/no-non-null-assertion -- 0 <= i < n <= column length
    y[i]! += x[i]! * DT;
  }
}

function relayEach(storage: Storage<typeof chainArch>): void {
  each(storage, (e) => {
    e.B.v += e.A.v * DT;
    e.D.v += e.C.v * DT;
    e.E.v += DT;
  });
}

/**
 * Inlined twin of `relayEach`, mirroring its `each` call as one column loop.
 *
 * @param storage - Storage to update, every row of it.
 * @throws TypeError when a column it reads is missing or not a `Float64Array`.
 */
function relayInlined(storage: Storage<typeof chainArch>): void {
  const a = f64Column(storage, CompA, "v");
  const b = f64Column(storage, CompB, "v");
  const c = f64Column(storage, CompC, "v");
  const d = f64Column(storage, CompD, "v");
  const e = f64Column(storage, CompE, "v");
  for (let i = storage.n - 1; i >= 0; i--) {
    // oxlint-disable-next-line typescript/no-non-null-assertion -- 0 <= i < n <= column length
    b[i]! += a[i]! * DT;
    // oxlint-disable-next-line typescript/no-non-null-assertion -- 0 <= i < n <= column length
    d[i]! += c[i]! * DT;
    // oxlint-disable-next-line typescript/no-non-null-assertion -- 0 <= i < n <= column length
    e[i]! += DT;
  }
}

function tickEach(storage: Storage<typeof soa1Arch>): void {
  each(storage, (e) => {
    e.F1.a += DT;
  });
}

/**
 * Inlined twin of `tickEach`, mirroring its `each` call as one column loop.
 *
 * @param storage - Storage to update, every row of it.
 * @throws TypeError when a column it reads is missing or not a `Float64Array`.
 */
function tickInlined(storage: Storage<typeof soa1Arch>): void {
  const a = f64Column(storage, F1, "a");
  for (let i = storage.n - 1; i >= 0; i--) {
    // oxlint-disable-next-line typescript/no-non-null-assertion -- 0 <= i < n <= column length
    a[i]! += DT;
  }
}

function accrueEach(storage: Storage<typeof soa2Arch>): void {
  each(storage, (e) => {
    e.F2.a += e.F2.b * DT;
  });
}

/**
 * Inlined twin of `accrueEach`, mirroring its `each` call as one column loop.
 *
 * @param storage - Storage to update, every row of it.
 * @throws TypeError when a column it reads is missing or not a `Float64Array`.
 */
function accrueInlined(storage: Storage<typeof soa2Arch>): void {
  const a = f64Column(storage, F2, "a");
  const b = f64Column(storage, F2, "b");
  for (let i = storage.n - 1; i >= 0; i--) {
    // oxlint-disable-next-line typescript/no-non-null-assertion -- 0 <= i < n <= column length
    a[i]! += b[i]! * DT;
  }
}

function pulseEach(storage: Storage<typeof soa5Arch>): void {
  each(storage, (e) => {
    e.F5.a += e.F5.b * DT;
    e.F5.c += e.F5.d * DT;
    e.F5.e += DT;
  });
}

/**
 * Inlined twin of `pulseEach`, mirroring its `each` call as one column loop.
 *
 * @param storage - Storage to update, every row of it.
 * @throws TypeError when a column it reads is missing or not a `Float64Array`.
 */
function pulseInlined(storage: Storage<typeof soa5Arch>): void {
  const a = f64Column(storage, F5, "a");
  const b = f64Column(storage, F5, "b");
  const c = f64Column(storage, F5, "c");
  const d = f64Column(storage, F5, "d");
  const e = f64Column(storage, F5, "e");
  for (let i = storage.n - 1; i >= 0; i--) {
    // oxlint-disable-next-line typescript/no-non-null-assertion -- 0 <= i < n <= column length
    a[i]! += b[i]! * DT;
    // oxlint-disable-next-line typescript/no-non-null-assertion -- 0 <= i < n <= column length
    c[i]! += d[i]! * DT;
    // oxlint-disable-next-line typescript/no-non-null-assertion -- 0 <= i < n <= column length
    e[i]! += DT;
  }
}

function sweepEach(storage: Storage<typeof soa10Arch>): void {
  each(storage, (e) => {
    e.F10.a += e.F10.b * DT;
    e.F10.c += e.F10.d * DT;
    e.F10.e += e.F10.f * DT;
    e.F10.g += e.F10.h * DT;
    e.F10.i += e.F10.j * DT;
  });
}

/**
 * Inlined twin of `sweepEach`, mirroring its `each` call as one column loop.
 *
 * @param storage - Storage to update, every row of it.
 * @throws TypeError when a column it reads is missing or not a `Float64Array`.
 */
function sweepInlined(storage: Storage<typeof soa10Arch>): void {
  const a = f64Column(storage, F10, "a");
  const b = f64Column(storage, F10, "b");
  const c = f64Column(storage, F10, "c");
  const d = f64Column(storage, F10, "d");
  const e = f64Column(storage, F10, "e");
  const f = f64Column(storage, F10, "f");
  const g = f64Column(storage, F10, "g");
  const h = f64Column(storage, F10, "h");
  const i = f64Column(storage, F10, "i");
  const j = f64Column(storage, F10, "j");
  for (let row = storage.n - 1; row >= 0; row--) {
    // oxlint-disable-next-line typescript/no-non-null-assertion -- 0 <= row < n <= column length
    a[row]! += b[row]! * DT;
    // oxlint-disable-next-line typescript/no-non-null-assertion -- 0 <= row < n <= column length
    c[row]! += d[row]! * DT;
    // oxlint-disable-next-line typescript/no-non-null-assertion -- 0 <= row < n <= column length
    e[row]! += f[row]! * DT;
    // oxlint-disable-next-line typescript/no-non-null-assertion -- 0 <= row < n <= column length
    g[row]! += h[row]! * DT;
    // oxlint-disable-next-line typescript/no-non-null-assertion -- 0 <= row < n <= column length
    i[row]! += j[row]! * DT;
  }
}

// ---------------------------------------------------------------------------
// Frames
// ---------------------------------------------------------------------------

/**
 * The `iteration/frame` body: the nine `each()` systems, one per storage, in a fixed order.
 *
 * @param frame - The world `makeFrameWorld` built; every one of its storages is updated.
 */
export function frameEach(frame: FrameCtx): void {
  throughputEach(frame.tracked);
  healEach(frame.bg);
  driftEach(frame.spawn);
  climbEach(frame.tag);
  relayEach(frame.chain);
  tickEach(frame.soa1);
  accrueEach(frame.soa2);
  pulseEach(frame.soa5);
  sweepEach(frame.soa10);
}

/**
 * Inlined twin of {@link frameEach}: the inlined twin of each of its `each` systems, in its order.
 *
 * @param frame - The world `makeFrameWorld` built; every one of its storages is updated.
 * @throws TypeError when a column an inlined system reads is missing or not a `Float64Array`.
 */
export function frameInlined(frame: FrameCtx): void {
  throughputInlined(frame.tracked);
  healInlined(frame.bg);
  driftInlined(frame.spawn);
  climbInlined(frame.tag);
  relayInlined(frame.chain);
  tickInlined(frame.soa1);
  accrueInlined(frame.soa2);
  pulseInlined(frame.soa5);
  sweepInlined(frame.soa10);
}
