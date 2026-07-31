/**
 * World builders and timing shims shared by the benchmark suites.
 */

import {
  type ArchetypeDescriptor,
  createWorld,
  destroyWorld,
  type EntityId,
  register,
  type Storage,
  spawn,
  type World,
} from "ecstatic";

import { bgArch, trackedArch } from "./archetypes.js";
import { mulberry32, shuffle } from "./random.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Total population is this multiple of N: 1 tracked entity per 4 background ones. */
export const WORLD_MULTIPLIER = 5;

/** Fixed timestep, so movement integration matches a 60 Hz frame. */
export const DT = 1 / 60;

/** Tracked-entity count every bench builds its world with. */
export const DEFAULT_N = 1000;

/** Seed for every world build — benchmarks must lay entities out identically on every run. */
const SEED = 42;

const NS_PER_MS = 1e6;

// ---------------------------------------------------------------------------
// World creation
// ---------------------------------------------------------------------------

/** A generator on the suite's fixed seed, so every world lays out identically. */
export function benchRandom(): () => number {
  return mulberry32(SEED);
}

export interface BenchCtx<A extends ArchetypeDescriptor> {
  world: World;
  tracked: EntityId[];
  trackedStorage: Storage<A>;
  n: number;
}

export interface CreateOpts {
  /** Skip the 4N background entities, isolating the tracked archetype. */
  noBackground?: boolean;
}

/**
 * Build a pre-populated world: N tracked entities carrying Position/Velocity,
 * plus 4N background entities of an unrelated archetype unless suppressed.
 *
 * The population is always `DEFAULT_N` tracked entities. The suite runs no
 * entity-count sweeps, and taking the count as a parameter would let one
 * benchmark quietly measure a different world than the rest.
 *
 * The tracked ID array is shuffled so index order does not match row order —
 * random-access benchmarks would otherwise walk the storage front to back and
 * measure a prefetch-friendly pattern no real workload has.
 */
export function benchCreateWorld(opts: CreateOpts = {}): BenchCtx<typeof trackedArch> {
  const n = DEFAULT_N;
  const rand = benchRandom();

  const world = createWorld();
  const trackedStorage = register(world, trackedArch);
  const bgStorage = register(world, bgArch);

  if (opts.noBackground !== true) {
    const bgCount = n * (WORLD_MULTIPLIER - 1);
    for (let i = 0; i < bgCount; i++) {
      spawn(bgStorage);
    }
  }

  const tracked: EntityId[] = [];
  for (let i = 1; i <= n; i++) {
    tracked.push(
      spawn(trackedStorage, {
        Position: { x: i, y: i * 2 },
        Velocity: { dx: 1, dy: -1 },
      }),
    );
  }

  shuffle(tracked, rand);

  return { world, tracked, trackedStorage, n };
}

export interface BareCtx<A extends ArchetypeDescriptor> {
  world: World;
  storage: Storage<A>;
  n: number;
}

/** Build a world holding nothing but `DEFAULT_N` default-valued entities of one archetype. */
export function makeBareWorld<A extends ArchetypeDescriptor>(arch: A): BareCtx<A> {
  const n = DEFAULT_N;
  const world = createWorld();
  const storage = register(world, arch);
  for (let i = 0; i < n; i++) {
    spawn(storage);
  }
  return { world, storage, n };
}

// ---------------------------------------------------------------------------
// Manual timing
// ---------------------------------------------------------------------------

/** The generator yield shape that puts mitata into manual-timing mode. */
export interface ManualYield {
  heap: false;
  manual: () => number;
}

/**
 * Time `body` against a world `build` produces fresh for every iteration.
 *
 * Benches whose body consumes the world it runs against — spawning, despawning,
 * anything that leaves the population changed — cannot reuse one world across
 * samples, and mitata's default batching would replay the body thousands of
 * times per sample against a world that only survives the first. Manual mode
 * disables batching and takes the elapsed nanoseconds this function returns,
 * which cover `body` alone: construction and teardown fall outside the clock.
 *
 * `heap: false` because the heap delta would otherwise be swamped by the
 * per-iteration world construction rather than reporting what `body` allocated.
 */
export function manualBench<C extends { world: World }>(
  build: () => C,
  body: (ctx: C) => void,
): ManualYield {
  return {
    heap: false,
    manual(): number {
      const ctx = build();

      // The world is released in a `finally` so a throwing body does not leak
      // it: mitata surfaces the exception, and every later iteration builds a
      // fresh world regardless.
      const started = performance.now();
      try {
        body(ctx);
        return (performance.now() - started) * NS_PER_MS;
      } finally {
        destroyWorld(ctx.world);
      }
    },
  };
}
