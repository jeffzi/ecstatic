/**
 * Iteration throughput: `each` over a whole storage, one pass at a time.
 *
 * These worlds carry no background entities — the tracked archetype is the only
 * one populated, so the numbers measure the iteration path itself rather than
 * dispatch across archetypes.
 */

import { despawn, despawnMany, destroyWorld, each, spawn } from "ecstatic";
import type { EntityId } from "ecstatic";

import { chainArch, soa1Arch, soa2Arch, soa5Arch, soa10Arch } from "./archetypes.js";
import {
  benchCreateWorld,
  frameBench,
  makeBareWorld,
  manualBench,
  throughputBench,
  timedBench,
} from "./helpers.js";
import { registerBench } from "./runner.js";
import { frameEach, throughputEach } from "./systems.js";

let sink = 0;

/**
 * Accumulated field reads and entity counts, kept live so V8 cannot elide the passes.
 *
 * @returns The running sum so far; meaningless as a number, it exists to be fed to
 * `do_not_optimize` after `run` returns.
 */
export function sinkValue(): number {
  return sink;
}

registerBench("iteration/throughput", throughputBench(throughputEach));

// Nine systems in a row, one per storage, each `each()` callback a different
// shape: what a frame of systems costs when they share the `each()` call site.
registerBench("iteration/frame", frameBench(frameEach));

// Same pass as throughput, but over a storage whose rows have been churned:
// five rounds of despawning every third entity and respawning the same count
// leave the freelist and row order fragmented the way a running game does.
registerBench("iteration/post_churn_throughput", function* () {
  const { world, trackedStorage: storage } = benchCreateWorld({ noBackground: true });

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

  const integrate = (): void => {
    throughputEach(storage);
  };
  integrate();

  yield timedBench(integrate);

  destroyWorld(world);
});

// Four dependent passes over one storage: each reads the column the previous
// pass wrote. Four separate traversals, not one pass doing four assignments.
registerBench("iteration/each_chained", function* () {
  const { world, storage } = makeBareWorld(chainArch);

  each(storage, (e) => {
    e.B.v = e.A.v;
  });

  yield timedBench(() => {
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
  });

  destroyWorld(world);
});

// Despawns every second entity from inside the callback iterating it — the
// swap-and-pop has to stay correct while the traversal is in flight.
registerBench("iteration/each_with_despawn", function* () {
  yield manualBench(
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
  );
});

// The soa_* family varies only in how many fields of one component the pass
// touches: 1, 2, 5, then 10. The spread shows what each extra column costs.
registerBench("iteration/soa_1field", function* () {
  const { world, storage } = makeBareWorld(soa1Arch);

  const pass = (): void => {
    each(storage, (e) => {
      sink += e.F1.a;
    });
  };
  pass();

  yield timedBench(pass);

  destroyWorld(world);
});

registerBench("iteration/soa_2field", function* () {
  const { world, storage } = makeBareWorld(soa2Arch);

  const pass = (): void => {
    each(storage, (e) => {
      sink += e.F2.a + e.F2.b;
    });
  };
  pass();

  yield timedBench(pass);

  destroyWorld(world);
});

registerBench("iteration/soa_5field", function* () {
  const { world, storage } = makeBareWorld(soa5Arch);

  const pass = (): void => {
    each(storage, (e) => {
      sink += e.F5.a + e.F5.b + e.F5.c + e.F5.d + e.F5.e;
    });
  };
  pass();

  yield timedBench(pass);

  destroyWorld(world);
});

registerBench("iteration/soa_10field", function* () {
  const { world, storage } = makeBareWorld(soa10Arch);

  const pass = (): void => {
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
  };
  pass();

  yield timedBench(pass);

  destroyWorld(world);
});

// The deferred alternative to each_with_despawn: collect the doomed IDs during
// the pass, then flush them in one batch once iteration is over.
registerBench("iteration/deferred_despawn", function* () {
  /**
   * Reused across iterations: the collect pass fills it and the flush empties
   * it. Emptying is not optional — leaving the IDs in place would hand
   * already-dead entities to `despawnMany` on every later iteration.
   */
  const deferredDead: EntityId[] = [];

  yield manualBench(
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
  );
});
