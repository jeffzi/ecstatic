/**
 * Iteration throughput: `each` over a whole storage, one pass at a time.
 *
 * These worlds carry no idle background population: every entity belongs to a
 * storage its benchmark iterates, so the numbers measure the iteration path
 * itself rather than world size.
 */

import { despawn, despawnMany, each, spawn } from "ecstatic";
import type { EntityId, Storage } from "ecstatic";

import {
  chainArch,
  soa1Arch,
  soa2Arch,
  soa5Arch,
  soa10Arch,
  type trackedArch,
} from "./archetypes.js";
import {
  benchCreateWorld,
  DT,
  makeBareWorld,
  makeFrameWorld,
  makeThroughputWorld,
  manualBench,
  warmedBench,
} from "./helpers.js";
import { registerBench } from "./runner.js";
import { frameEach, throughputEach } from "./systems.js";

let sink = 0;

/**
 * Accumulated field reads and entity counts, kept live so V8 cannot elide the passes.
 *
 * @returns The running sum so far; meaningless as a number, returned only so the accumulated work
 * stays reachable.
 */
export function sinkValue(): number {
  return sink;
}

registerBench(
  "iteration/throughput",
  warmedBench(makeThroughputWorld, ({ trackedStorage }) => {
    throughputEach(trackedStorage);
  }),
);

// Nine systems in a row, one per storage, each `each()` callback a different
// shape: what a frame of systems costs when they share the `each()` call site.
registerBench("iteration/frame", warmedBench(makeFrameWorld, frameEach));

function advance(x: number, dx: number): number {
  return x + dx * DT;
}

// The call to a helper is what makes this body hazard-bearing: a call may spawn past
// capacity and reallocate the columns, so the optimizer's realloc-safe mode re-reads them
// through the storage on each access. The call is the body's only hazard, so set beside
// `iteration/throughput` it shows what realloc-safe mode costs a plain field update;
// inlining `advance` would make the body hazard-free and lose that measurement.
registerBench(
  "iteration/helper_call",
  warmedBench(makeThroughputWorld, ({ trackedStorage }) => {
    each(trackedStorage, (e) => {
      e.Position.x = advance(e.Position.x, e.Velocity.dx);
    });
  }),
);

// Five rounds of despawning every third entity and respawning the same count
// leave the freelist and row order fragmented the way a running game does.
function churnRows(storage: Storage<typeof trackedArch>): void {
  for (let round = 0; round < 5; round++) {
    const victims: EntityId[] = [];
    let count = 0;
    each(storage, (e) => {
      count += 1;
      if (count % 3 === 0) {
        victims.push(e.id);
      }
    });
    for (let k = 0; k < victims.length; k++) {
      // oxlint-disable-next-line typescript/no-non-null-assertion -- k < victims.length
      despawn(storage, victims[k]!);
    }
    for (let k = 0; k < victims.length; k++) {
      sink += spawn(storage);
    }
  }
}

// Same pass as throughput, but over a storage whose rows have been churned.
registerBench(
  "iteration/post_churn_throughput",
  warmedBench(
    () => {
      const ctx = makeThroughputWorld();
      churnRows(ctx.trackedStorage);
      return ctx;
    },
    ({ trackedStorage }) => {
      throughputEach(trackedStorage);
    },
  ),
);

// Four dependent passes over one storage: each reads the column the previous
// pass wrote. Four separate traversals, not one pass doing four assignments.
registerBench(
  "iteration/each_chained",
  warmedBench(
    () => makeBareWorld(chainArch),
    ({ storage }) => {
      each(storage, (e) => {
        e.B.v = e.A.v;
      });
      each(storage, (e) => {
        e.C.v = e.B.v;
      });
      each(storage, (e) => {
        e.D.v = e.C.v;
      });
      each(storage, (e) => {
        e.E.v = e.D.v;
      });
    },
  ),
);

// Despawns every second entity from inside the callback iterating it — the
// swap-and-pop has to stay correct while the traversal is in flight.
registerBench(
  "iteration/each_with_despawn",
  manualBench(
    () => {
      const ctx = benchCreateWorld({ noBackground: true });
      each(ctx.trackedStorage, () => {});
      return ctx;
    },
    ({ trackedStorage: storage }) => {
      let count = 0;
      each(storage, (e) => {
        count += 1;
        if (count % 2 === 0) {
          despawn(storage, e.id);
        }
      });
      sink += count;
    },
  ),
);

// The soa_* family varies only in how many fields of one component the pass
// touches: 1, 2, 5, then 10. The spread is not monotonic in field count:
// soa_5field runs slower than soa_10field. Track each one against its own
// history rather than reading the gap between neighbors as a per-column price.
registerBench(
  "iteration/soa_1field",
  warmedBench(
    () => makeBareWorld(soa1Arch),
    ({ storage }) => {
      each(storage, (e) => {
        sink += e.F1.a;
      });
    },
  ),
);

registerBench(
  "iteration/soa_2field",
  warmedBench(
    () => makeBareWorld(soa2Arch),
    ({ storage }) => {
      each(storage, (e) => {
        sink += e.F2.a + e.F2.b;
      });
    },
  ),
);

registerBench(
  "iteration/soa_5field",
  warmedBench(
    () => makeBareWorld(soa5Arch),
    ({ storage }) => {
      each(storage, (e) => {
        sink += e.F5.a + e.F5.b + e.F5.c + e.F5.d + e.F5.e;
      });
    },
  ),
);

registerBench(
  "iteration/soa_10field",
  warmedBench(
    () => makeBareWorld(soa10Arch),
    ({ storage }) => {
      each(storage, (e) => {
        sink +=
          e.F10.a +
          e.F10.b +
          e.F10.c +
          e.F10.d +
          e.F10.e +
          e.F10.f +
          e.F10.g +
          e.F10.h +
          e.F10.i +
          e.F10.j;
      });
    },
  ),
);

/**
 * Reused across samples: the collect pass fills it and the flush empties it.
 * Emptying is not optional — leaving the IDs in place would hand already-dead
 * entities to `despawnMany` on every later sample.
 */
const deferredDead: EntityId[] = [];

// The deferred alternative to each_with_despawn: collect the doomed IDs during
// the pass, then flush them in one batch once iteration is over.
registerBench(
  "iteration/deferred_despawn",
  manualBench(
    () => {
      const ctx = benchCreateWorld({ noBackground: true });
      const storage = ctx.trackedStorage;

      let seen = 0;
      each(storage, (e) => {
        seen += 1;
        if (seen % 2 === 0) {
          deferredDead.push(e.id);
        }
      });
      const collected = deferredDead.length;
      despawnMany(storage, deferredDead);
      deferredDead.length = 0;

      for (let k = 0; k < collected; k++) {
        spawn(storage);
      }
      return ctx;
    },
    ({ trackedStorage: storage }) => {
      let seen = 0;
      each(storage, (e) => {
        seen += 1;
        if (seen % 2 === 0) {
          deferredDead.push(e.id);
        }
      });
      despawnMany(storage, deferredDead);
      deferredDead.length = 0;
    },
  ),
);
