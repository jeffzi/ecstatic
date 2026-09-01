/**
 * Single-entity lifecycle: `spawn`, `despawn`, `alive`, one call at a time.
 *
 * Bodies that leave the population changed run under `manualBench`, which
 * rebuilds the world untimed before each sample. `spawn_recycle` and
 * `alive_check` restore what they touch, so they reuse one world instead.
 */

import { alive, despawn, destroyWorld, register, spawn } from "ecstatic";
import type { EntityId } from "ecstatic";

import { emptyArch, spawnArch } from "./archetypes.js";
import { benchCreateWorld, benchRandom, manualBench, timedBench } from "./helpers.js";
import { shuffle } from "./random.js";
import { registerBench } from "./runner.js";

let sink = 0;

/** Accumulated spawn IDs and alive hits, kept live so V8 cannot elide the calls. */
export function sinkValue(): number {
  return sink;
}

registerBench("entity/spawn_empty", function* () {
  yield manualBench(
    () => {
      const ctx = benchCreateWorld();
      return { ...ctx, emptyStorage: register(ctx.world, emptyArch) };
    },
    ({ n, emptyStorage }) => {
      for (let i = 0; i < n; i++) {
        sink += spawn(emptyStorage);
      }
    },
  );
});

registerBench("entity/spawn_with_data", function* () {
  yield manualBench(
    () => {
      const ctx = benchCreateWorld();
      return { ...ctx, spawnStorage: register(ctx.world, spawnArch) };
    },
    ({ n, spawnStorage }) => {
      for (let i = 0; i < n; i++) {
        sink += spawn(spawnStorage, { Position: { x: 0, y: 0 } });
      }
    },
  );
});

// Same spawn as spawn_with_data, but the overrides object is allocated once and
// passed by reference on every call — the delta is what building a fresh
// override literal per spawn costs.
registerBench("entity/spawn_indirect", function* () {
  yield manualBench(
    () => {
      const ctx = benchCreateWorld();
      return { ...ctx, spawnStorage: register(ctx.world, spawnArch) };
    },
    ({ n, spawnStorage }) => {
      const overrides = { Position: { x: 0, y: 0 } };
      for (let i = 0; i < n; i++) {
        sink += spawn(spawnStorage, overrides);
      }
    },
  );
});

registerBench("entity/despawn", function* () {
  yield manualBench(
    () => benchCreateWorld(),
    ({ n, trackedStorage, tracked }) => {
      for (let i = 0; i < n; i++) {
        // oxlint-disable-next-line typescript/no-non-null-assertion -- i < n = tracked.length
        despawn(trackedStorage, tracked[i]!);
      }
    },
  );
});

// Net-neutral: despawns all N tracked entities, then spawns N back, so the
// population is unchanged at the end of every iteration and the freelist is
// exercised in its steady state.
registerBench("entity/spawn_recycle", function* () {
  const { world, n, trackedStorage: storage, tracked } = benchCreateWorld();

  yield timedBench(() => {
    for (let i = 0; i < n; i++) {
      // oxlint-disable-next-line typescript/no-non-null-assertion -- i < n = tracked.length
      despawn(storage, tracked[i]!);
    }
    for (let i = 0; i < n; i++) {
      tracked[i] = spawn(storage);
    }
    // oxlint-disable-next-line typescript/no-non-null-assertion -- n ≥ 1 and tracked has n elements after the refill
    sink += tracked[n - 1]!;
  });

  destroyWorld(world);
});

// Half the IDs checked are stale — the ones spawned and immediately despawned
// during setup — so the generation comparison takes both outcomes.
registerBench("entity/alive_check", function* () {
  const { world, n, trackedStorage: storage, tracked } = benchCreateWorld();

  const stale: EntityId[] = [];
  for (let i = 0; i < n; i++) {
    stale.push(spawn(storage));
  }
  for (let i = 0; i < n; i++) {
    // oxlint-disable-next-line typescript/no-non-null-assertion -- i < n = stale.length
    despawn(storage, stale[i]!);
  }

  const mixed = [...tracked, ...stale];
  shuffle(mixed, benchRandom());

  yield timedBench(() => {
    for (let i = 0; i < mixed.length; i++) {
      // oxlint-disable-next-line typescript/no-non-null-assertion -- i < mixed.length
      if (alive(storage, mixed[i]!)) {
        sink += 1;
      }
    }
  });

  destroyWorld(world);
});
