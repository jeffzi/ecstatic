import { createWorld, getStorage, register, spawnMany, type Storage, type World } from "ecstatic";
import { describe, expect, it } from "vitest";

import { Position, type trackedArch, Velocity } from "../../benchmarks/archetypes.js";
import { DEFAULT_N, DT, makeFrameWorld, makeThroughputWorld } from "../../benchmarks/helpers.js";
import {
  frameEach,
  frameFused,
  throughputEach,
  throughputFused,
} from "../../benchmarks/systems.js";
import { FRAME_ARCHETYPES, liveValues } from "./fixtures.js";

/** A column holding one value per row: a typed array, or a plain array for ref and string fields. */
type Column = Storage["flatColumns"][number];

/** Spawns allowed per storage while waiting for its columns to grow; far above any capacity step. */
const MAX_GROWTH_SPAWNS = 1_000_000;

/** Gap between consecutive fields' seeded values, so each field keeps its own value band. */
const SEED_FIELD_STRIDE = 10_000;

/** Added to every seeded value to keep it off integer defaults, so a missed write shows. */
const SEED_OFFSET = 0.5;

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

/**
 * Walks every column of every component in a storage.
 *
 * @param storage - The storage whose component columns are walked.
 * @yields One `{ field, key, column }` entry per column: `field` is `<Component>.<field>`, `key`
 * is `<storage id>:<Component>.<field>`, and `column` holds the values.
 */
function* storageFields(
  storage: Storage,
): Generator<{ field: string; key: string; column: Column }> {
  for (const [name, descriptor] of storage.componentByName) {
    const fields = storage.columns.get(descriptor) ?? {};
    for (const [field, column] of Object.entries(fields)) {
      yield { field: `${name}.${field}`, key: `${String(storage.id)}:${name}.${field}`, column };
    }
  }
}

/** Every column of every component in `storage`, keyed `<storage id>:<Component>.<field>`. */
function storageColumns(storage: Storage): Map<string, Column> {
  const columns = new Map<string, Column>();
  for (const { key, column } of storageFields(storage)) {
    columns.set(key, column);
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

/** Each storage's live rows of every column of `world`, keyed by archetype, then `<Component>.<field>`. */
function liveColumnsByArchetype(world: World): Map<unknown, Map<string, unknown[]>> {
  const byArchetype = new Map<unknown, Map<string, unknown[]>>();
  for (const storage of world.storages.values()) {
    const columns = new Map<string, unknown[]>();
    for (const { field, column } of storageFields(storage)) {
      columns.set(field, Array.from(column).slice(0, storage.n));
    }
    byArchetype.set(storage.archetype, columns);
  }
  return byArchetype;
}

/** A world holding `DEFAULT_N` entities of each frame archetype, spawned with no overrides. */
function defaultFrameWorld(): World {
  const world = createWorld();
  for (const arch of FRAME_ARCHETYPES) {
    // Widened to bare Storage: the no-overrides spawn form is rejected for archetypes with a
    // required relation, and the union of frame archetypes cannot prove it has none.
    const storage: Storage = register(world, arch);
    spawnMany(storage, DEFAULT_N);
  }
  return world;
}

/** The tracked storage's live `[x, y]` rows. */
function positionsOf(storage: Storage<typeof trackedArch>): number[][] {
  const y = liveValues(storage, Position, "y");
  return liveValues(storage, Position, "x").map((x, row) => [x, Number(y[row])]);
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

/** Per-storage column copies, keyed by storage id. */
type StorageSnapshots = Map<string, Map<string, unknown[]>>;

/** A copy of every column of each storage in `world`, keyed by storage id. */
function snapshotByStorage(world: World): StorageSnapshots {
  return new Map(
    [...world.storages.values()].map(
      (storage) => [String(storage.id), copyColumns(storageColumns(storage))] as const,
    ),
  );
}

/** The ids of the storages in `world` with at least one column that differs from `before`. */
function changedStorageIds(before: StorageSnapshots, world: World): Set<string> {
  const changed = new Set<string>();
  for (const [id, columns] of snapshotByStorage(world)) {
    if (columnMismatches(before.get(id) ?? new Map(), columns).length > 0) {
      changed.add(id);
    }
  }
  return changed;
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
        column[row] = fieldIndex * SEED_FIELD_STRIDE + row + SEED_OFFSET;
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
      const ctx = makeThroughputWorld();
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

/** Both twins' worlds, `viaEach`'s first. */
function bothWorlds({ viaEach, viaFused }: Twins): World[] {
  return [viaEach.world, viaFused.world];
}

/** Builds two rigs with `create` and seeds both worlds identically. */
function seededTwins(create: () => Rig): Twins {
  const twins = { viaEach: create(), viaFused: create() };
  for (const world of bothWorlds(twins)) {
    seed(world);
  }
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
  it("builds nine frame storages of DEFAULT_N default-valued entities", () => {
    const expected = liveColumnsByArchetype(defaultFrameWorld());

    const { world } = makeFrameWorld();

    expect(liveColumnsByArchetype(world)).toStrictEqual(expected);
  });
});

describe("throughputEach", () => {
  it("advances every Position by its Velocity times DT", () => {
    const ctx = makeThroughputWorld();
    seed(ctx.world);
    const expected = advancedPositions(ctx.trackedStorage);

    throughputEach(ctx.trackedStorage);

    expect(positionsOf(ctx.trackedStorage)).toStrictEqual(expected);
  });
});

describe("frameEach", () => {
  it("writes to each of the nine frame storages", () => {
    const frame = makeFrameWorld();
    seed(frame.world);
    const before = snapshotByStorage(frame.world);

    frameEach(frame);

    expect(changedStorageIds(before, frame.world)).toStrictEqual(
      new Set(FRAME_ARCHETYPES.map((arch) => String(getStorage(frame.world, arch).id))),
    );
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
  it.each(RIGS)("leave $label's columns bitwise identical after the first pass", ({ create }) => {
    const twins = seededTwins(create);

    runPass(twins);

    expect(twinMismatches(twins)).toStrictEqual([]);
  });

  describe("when every storage grows past its capacity between passes", () => {
    it.each(RIGS)("leave $label's columns bitwise identical", ({ create }) => {
      const twins = seededTwins(create);
      runPass(twins);
      for (const world of bothWorlds(twins)) {
        growPastCapacity(world);
        seed(world);
      }

      runPass(twins);

      expect(twinMismatches(twins)).toStrictEqual([]);
    });
  });
});
