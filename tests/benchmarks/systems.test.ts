import { getStorage, spawnMany, type Storage, type World } from "ecstatic";
import { describe, expect, it } from "vitest";

import {
  bgArch,
  chainArch,
  Position,
  soa10Arch,
  soa1Arch,
  soa2Arch,
  soa5Arch,
  spawnArch,
  tagArch,
  trackedArch,
  Velocity,
} from "../../benchmarks/archetypes.js";
import { benchCreateWorld, DEFAULT_N, DT, makeFrameWorld } from "../../benchmarks/helpers.js";
import {
  frameEach,
  frameFused,
  throughputEach,
  throughputFused,
} from "../../benchmarks/systems.js";

const PASSES = 3;

const FRAME_ARCHETYPES = [
  { label: "trackedArch", arch: trackedArch },
  { label: "bgArch", arch: bgArch },
  { label: "spawnArch", arch: spawnArch },
  { label: "tagArch", arch: tagArch },
  { label: "chainArch", arch: chainArch },
  { label: "soa1Arch", arch: soa1Arch },
  { label: "soa2Arch", arch: soa2Arch },
  { label: "soa5Arch", arch: soa5Arch },
  { label: "soa10Arch", arch: soa10Arch },
];

/** A column holding one value per row: a typed array, or a plain array for ref and string fields. */
type Column = Storage["flatColumns"][number];

/** Spawns allowed per storage while waiting for its columns to grow; far above any capacity step. */
const MAX_GROWTH_SPAWNS = 1_000_000;

/** Every column of every component in every storage of `world`, keyed `<storage id>:<Component>.<field>`. */
function worldColumns(world: World): Map<string, Column> {
  const columns = new Map<string, Column>();
  for (const storage of world.storages.values()) {
    for (const [key, column] of storageColumns(storage)) {
      columns.set(key, column);
    }
  }
  return columns;
}

/** Every column of every component in `storage`, keyed `<storage id>:<Component>.<field>`. */
function storageColumns(storage: Storage): Map<string, Column> {
  const columns = new Map<string, Column>();
  for (const [name, descriptor] of storage.componentByName) {
    const fields = storage.columns.get(descriptor) ?? {};
    for (const [field, column] of Object.entries(fields)) {
      columns.set(`${String(storage.id)}:${name}.${field}`, column);
    }
  }
  return columns;
}

/** A copy of every column of `world`, so later writes cannot change it. */
function snapshot(world: World): Map<string, unknown[]> {
  return copyColumns(worldColumns(world));
}

/** A copy of every column in `columns`, so later writes cannot change it. */
function copyColumns(columns: Map<string, Column>): Map<string, unknown[]> {
  const copies = new Map<string, unknown[]>();
  for (const [key, column] of columns) {
    copies.set(key, Array.from(column));
  }
  return copies;
}

/** One line per live cell of `world` whose value differs from its component's declared default. */
function nonDefaultCells(world: World): string[] {
  const cells: string[] = [];
  for (const storage of world.storages.values()) {
    for (const [name, descriptor] of storage.componentByName) {
      const fields = storage.columns.get(descriptor) ?? {};
      for (const [field, column] of Object.entries(fields)) {
        const prefix = `${String(storage.id)}:${name}.${field}`;
        cells.push(
          ...offDefaultRows(prefix, column, storage.n, descriptor.__ecstatic_defaults[field]),
        );
      }
    }
  }
  return cells;
}

/** `<prefix>[row]` for each of the first `n` rows of `column` that is not `fallback`. */
function offDefaultRows(prefix: string, column: Column, n: number, fallback: unknown): string[] {
  const rows: string[] = [];
  for (let row = 0; row < n; row++) {
    if (!Object.is(column[row], fallback)) {
      rows.push(`${prefix}[${String(row)}]`);
    }
  }
  return rows;
}

/** The tracked storage's live `[x, y]` rows. */
function positionsOf(storage: Storage<typeof trackedArch>): number[][] {
  const position = storage.columns.get(Position);
  const rows: number[][] = [];
  for (let row = 0; row < storage.n; row++) {
    rows.push([Number(position?.["x"]?.[row]), Number(position?.["y"]?.[row])]);
  }
  return rows;
}

/** The tracked storage's live `[x, y]` rows after one integration step by `Velocity * DT`. */
function advancedPositions(storage: Storage<typeof trackedArch>): number[][] {
  const velocity = storage.columns.get(Velocity);
  return positionsOf(storage).map(([x = 0, y = 0], row) => [
    x + Number(velocity?.["dx"]?.[row]) * DT,
    y + Number(velocity?.["dy"]?.[row]) * DT,
  ]);
}

/**
 * Every place where two column snapshots disagree, compared with `Object.is` per element.
 *
 * @param expected - Snapshot of the world the `each()` bodies ran over.
 * @param actual - Snapshot of the world the fused bodies ran over.
 * @returns One line per missing column, length mismatch, or differing row; empty when the two are
 * bitwise identical.
 */
function columnMismatches(
  expected: Map<string, unknown[]>,
  actual: Map<string, unknown[]>,
): string[] {
  const mismatches: string[] = [];
  const keys = new Set([...expected.keys(), ...actual.keys()]);
  for (const key of keys) {
    const want = expected.get(key);
    const got = actual.get(key);
    if (want === undefined || got === undefined) {
      mismatches.push(`${key}: present in only one world`);
      continue;
    }
    if (want.length !== got.length) {
      mismatches.push(`${key}: length ${String(want.length)} vs ${String(got.length)}`);
      continue;
    }
    for (let row = 0; row < want.length; row++) {
      if (!Object.is(want[row], got[row])) {
        mismatches.push(`${key}[${String(row)}]: ${String(want[row])} vs ${String(got[row])}`);
      }
    }
  }
  return mismatches;
}

/** Overwrites every live row of every typed column in `world` with a value unique to its row and field. */
function seed(world: World): void {
  let fieldIndex = 0;
  for (const storage of world.storages.values()) {
    for (const column of storageColumns(storage).values()) {
      fieldIndex += 1;
      if (Array.isArray(column)) {
        continue;
      }
      for (let row = 0; row < storage.n; row++) {
        column[row] = fieldIndex * 10_000 + row + 0.5;
      }
    }
  }
}

/**
 * Spawns into every storage of `world`, one entity at a time, until growth has replaced every one
 * of its typed columns.
 *
 * @param world - The world whose storages to grow.
 * @throws Error when a storage still holds one of its original typed columns after
 * `MAX_GROWTH_SPAWNS` spawns.
 */
function growPastCapacity(world: World): void {
  for (const storage of world.storages.values()) {
    const original = new Set(storageColumns(storage).values());
    const stillOriginal = (): boolean =>
      [...storageColumns(storage).values()].some(
        (column) => !Array.isArray(column) && original.has(column),
      );
    let spawned = 0;
    while (stillOriginal()) {
      if (spawned >= MAX_GROWTH_SPAWNS) {
        throw new Error(`storage ${String(storage.id)} never grew its columns`);
      }
      spawnMany(storage, 1);
      spawned += 1;
    }
  }
}

/** A world whose `each` and `fused` bodies both close over that same world's storages. */
interface Rig {
  world: World;
  each: () => void;
  fused: () => void;
}

/** Two identically built rigs: `viaEach` runs its each() body, `viaFused` its fused one. */
interface Twins {
  viaEach: Rig;
  viaFused: Rig;
}

const RIGS = [
  {
    label: "throughputEach",
    create: (): Rig => {
      const ctx = benchCreateWorld({ noBackground: true });
      return {
        world: ctx.world,
        each: () => {
          throughputEach(ctx.trackedStorage);
        },
        fused: () => {
          throughputFused(ctx.trackedStorage);
        },
      };
    },
  },
  {
    label: "frameEach",
    create: (): Rig => {
      const frame = makeFrameWorld();
      return {
        world: frame.world,
        each: () => {
          frameEach(frame);
        },
        fused: () => {
          frameFused(frame);
        },
      };
    },
  },
];

/** Builds two rigs with `create` and seeds both worlds identically. */
function seededTwins(create: () => Rig): Twins {
  const twins = { viaEach: create(), viaFused: create() };
  seed(twins.viaEach.world);
  seed(twins.viaFused.world);
  return twins;
}

/** Runs the each() body over `viaEach` and the fused body over `viaFused`, once. */
function runPass({ viaEach, viaFused }: Twins): void {
  viaEach.each();
  viaFused.fused();
}

/** Every place where the two worlds' columns differ. */
function twinMismatches({ viaEach, viaFused }: Twins): string[] {
  return columnMismatches(snapshot(viaEach.world), snapshot(viaFused.world));
}

describe("makeFrameWorld", () => {
  it("holds DEFAULT_N entities in each of the nine frame storages and nothing else", () => {
    const { world } = makeFrameWorld();

    const counts = FRAME_ARCHETYPES.map(({ arch }) => getStorage(world, arch).n);

    expect(counts).toStrictEqual(FRAME_ARCHETYPES.map(() => DEFAULT_N));
    expect(world.storages.size).toBe(FRAME_ARCHETYPES.length);
  });

  it("fills every live row of every column with its component's declared default", () => {
    const { world } = makeFrameWorld();

    const offDefault = nonDefaultCells(world);

    expect(offDefault).toStrictEqual([]);
  });
});

describe("throughputEach", () => {
  it("advances every Position by its Velocity times DT", () => {
    const ctx = benchCreateWorld({ noBackground: true });
    seed(ctx.world);
    const expected = advancedPositions(ctx.trackedStorage);

    throughputEach(ctx.trackedStorage);

    expect(positionsOf(ctx.trackedStorage)).toStrictEqual(expected);
  });
});

describe("frameEach", () => {
  it.each(FRAME_ARCHETYPES)("writes to the $label storage", ({ arch }) => {
    const frame = makeFrameWorld();
    seed(frame.world);
    const storage = getStorage(frame.world, arch);
    const before = snapshot(frame.world);

    frameEach(frame);

    const changed = columnMismatches(before, snapshot(frame.world)).filter((line) =>
      line.startsWith(`${String(storage.id)}:`),
    );
    expect(changed).not.toStrictEqual([]);
  });

  it("updates the tracked storage exactly as throughputEach does", () => {
    const viaFrame = makeFrameWorld();
    const viaThroughput = makeFrameWorld();
    seed(viaFrame.world);
    seed(viaThroughput.world);
    throughputEach(viaThroughput.tracked);

    frameEach(viaFrame);

    expect(
      columnMismatches(
        copyColumns(storageColumns(viaThroughput.tracked)),
        copyColumns(storageColumns(viaFrame.tracked)),
      ),
    ).toStrictEqual([]);
  });
});

describe("fused bodies", () => {
  describe("when run over a seeded world", () => {
    it.each(RIGS)("leave $label's columns bitwise identical", ({ create }) => {
      const twins = seededTwins(create);

      for (let pass = 0; pass < PASSES; pass++) {
        runPass(twins);
      }

      expect(twinMismatches(twins)).toStrictEqual([]);
    });
  });

  describe("when every storage grows past its capacity between passes", () => {
    it.each(RIGS)("leave $label's columns bitwise identical", ({ create }) => {
      const twins = seededTwins(create);
      runPass(twins);
      growPastCapacity(twins.viaEach.world);
      growPastCapacity(twins.viaFused.world);
      seed(twins.viaEach.world);
      seed(twins.viaFused.world);

      runPass(twins);

      expect(twinMismatches(twins)).toStrictEqual([]);
    });
  });
});
