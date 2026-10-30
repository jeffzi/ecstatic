/**
 * Batch lifecycle: one `spawnMany`/`despawnMany` call covering what the
 * entity suite does with N individual calls.
 *
 * Every body consumes the world it runs against, so all of these run under
 * `manualBench`, which builds fresh worlds untimed, one per body run a sample
 * times.
 */

import { despawnMany, register, spawn, spawnMany } from "ecstatic";
import type { EntityId } from "ecstatic";

import { emptyArch, spawnArch } from "./archetypes.js";
import { benchCreateWorld, benchRandom, manualBench } from "./helpers.js";
import { shuffle } from "./random.js";
import { registerBench } from "./runner.js";

let sink = 0;

/**
 * Accumulated batch sizes, kept live so V8 cannot elide the calls.
 *
 * @returns The running sum so far; meaningless as a number, returned only so the accumulated work
 * stays reachable.
 */
export function sinkValue(): number {
  return sink;
}

registerBench(
  "many/spawn_empty",
  manualBench(
    () => {
      const ctx = benchCreateWorld();
      return { ...ctx, emptyStorage: register(ctx.world, emptyArch) };
    },
    ({ n, emptyStorage }) => {
      sink += spawnMany(emptyStorage, n).length;
    },
  ),
);

registerBench(
  "many/spawn_with_data",
  manualBench(
    () => {
      const ctx = benchCreateWorld();
      return { ...ctx, spawnStorage: register(ctx.world, spawnArch) };
    },
    ({ n, spawnStorage }) => {
      sink += spawnMany(spawnStorage, n, { Position: { x: 0, y: 0 } }).length;
    },
  ),
);

// Writes into a caller-owned array instead of returning a fresh one. Setup runs
// a full spawn/despawn cycle first so the buffer is already grown to N and the
// timed call measures reuse, not the growth it would otherwise pay for once.
registerBench(
  "many/spawn_out_reuse",
  manualBench(
    () => {
      const ctx = benchCreateWorld();
      const spawnStorage = register(ctx.world, spawnArch);
      const out: EntityId[] = [];
      spawnMany(spawnStorage, ctx.n, { Position: { x: 0, y: 0 } }, out);
      despawnMany(spawnStorage, out);
      return { ...ctx, spawnStorage, out };
    },
    ({ n, spawnStorage, out }) => {
      spawnMany(spawnStorage, n, { Position: { x: 0, y: 0 } }, out);
    },
  ),
);

registerBench(
  "many/despawn",
  manualBench(benchCreateWorld, ({ trackedStorage, tracked }) => {
    despawnMany(trackedStorage, tracked);
  }),
);

registerBench(
  "many/despawn_half",
  manualBench(
    () => {
      const ctx = benchCreateWorld();
      return { ...ctx, trackedHalf: ctx.tracked.slice(0, Math.floor(ctx.n / 2)) };
    },
    ({ trackedStorage, trackedHalf }) => {
      despawnMany(trackedStorage, trackedHalf);
    },
  ),
);

// The all-entities overload: no ID list to walk, so the storage can clear its
// rows wholesale instead of swap-and-popping each one.
registerBench(
  "many/despawn_all",
  manualBench(benchCreateWorld, ({ trackedStorage }) => {
    despawnMany(trackedStorage);
  }),
);

// IDs from two archetypes, shuffled together, despawned through the world
// rather than a storage — each ID has to be routed to its own storage first.
registerBench(
  "many/despawn_world",
  manualBench(
    () => {
      const ctx = benchCreateWorld();
      const spawnStorage = register(ctx.world, spawnArch);
      const half = Math.floor(ctx.n / 2);

      const mixed: EntityId[] = ctx.tracked.slice(0, half);
      for (let i = 1; i <= ctx.n - half; i++) {
        mixed.push(spawn(spawnStorage, { Position: { x: i, y: i * 2 } }));
      }
      shuffle(mixed, benchRandom());

      return { world: ctx.world, mixed };
    },
    ({ world, mixed }) => {
      despawnMany(world, mixed);
    },
  ),
);
