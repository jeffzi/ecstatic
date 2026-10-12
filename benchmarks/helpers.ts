/**
 * World builders and timing shims shared by the benchmark suites.
 */

import {
  createWorld,
  despawnMany,
  destroyWorld,
  type EntityId,
  register,
  type Storage,
  spawn,
  spawnMany,
  type World,
} from "ecstatic";

import { bgArch, trackedArch } from "./archetypes.js";
import { mulberry32, shuffle } from "./random.js";
import { parseGeneration } from "./runner.js";

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

/**
 * Create a generator on the suite's fixed seed, so every world lays out identically.
 *
 * @returns A fresh mulberry32 generator yielding floats in `[0, 1)`; every call to this function
 * starts the same sequence over from the beginning.
 */
export function benchRandom(): () => number {
  return mulberry32(SEED);
}

/**
 * Constraint for the archetype a bench world is built around, recovered from
 * the storage type: the descriptor type itself is not part of the package's
 * export surface, so it cannot be named directly here.
 */
type AnyArchetype = Storage["archetype"];

export interface BenchCtx<A extends AnyArchetype> {
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
 * The `BENCH_GENERATION` environment variable selects the generation of the
 * tracked ids. Unset or `1`, every slot is fresh and the freelist is empty.
 * Above `1`, the tracked slots are recycled until every tracked id sits at
 * that generation, and `DEFAULT_N` free slots at the same generation stay on
 * the freelist, so a benchmark that spawns into the tracked storage draws
 * recycled slots too. Background entities stay at generation 1 either way.
 *
 * @param opts - `noBackground: true` skips the 4N background entities, isolating the tracked
 * archetype; the default builds them.
 * @returns The world, its tracked storage, and `n` (always `DEFAULT_N`); the caller owns the
 * world and nothing here releases it. `tracked` holds the N ids shuffled so index order does not
 * match row order — random-access benchmarks would otherwise walk the storage front to back and
 * measure a prefetch-friendly pattern no real workload has.
 * @throws UsageError when `BENCH_GENERATION` is set to anything but an integer of at least 1.
 */
export function benchCreateWorld(opts: CreateOpts = {}): BenchCtx<typeof trackedArch> {
  const n = DEFAULT_N;
  const generation = parseGeneration(process.env["BENCH_GENERATION"]);
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

  ageTrackedSlots(trackedStorage, generation);

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

/**
 * Make the next spawns into the storage come out at `generation`.
 *
 * A slot's generation advances on despawn and a first spawn yields generation
 * 1, so `2 * DEFAULT_N` slots are spawned and despawned `generation - 1`
 * times and left on the freelist. Generation 1 takes no rounds: the storage
 * and the freelist are untouched, and the next spawns claim fresh slots.
 *
 * @param storage - Tracked storage, holding no entities yet; it is left empty again.
 * @param generation - Generation the next spawns into `storage` must come out at; at least 1.
 */
function ageTrackedSlots(storage: Storage<typeof trackedArch>, generation: number): void {
  const ids: EntityId[] = [];
  for (let round = 1; round < generation; round++) {
    spawnMany(storage, 2 * DEFAULT_N, ids);
    despawnMany(storage, ids);
  }
}

export interface BareCtx<A extends AnyArchetype> {
  world: World;
  storage: Storage<A>;
  n: number;
}

/**
 * Build a world holding nothing but `DEFAULT_N` default-valued entities of one archetype.
 *
 * @param arch - Archetype to register and spawn from; it must declare no required relation,
 * since every entity is spawned with no overrides.
 * @returns The world, the registered storage for `arch`, and `n` (always `DEFAULT_N`); the
 * caller owns the world and nothing here releases it.
 */
export function makeBareWorld<A extends AnyArchetype>(arch: A): BareCtx<A> {
  const n = DEFAULT_N;
  const world = createWorld();
  const storage = register(world, arch);
  // Widened to bare Storage: the generic A is unresolved here, so the
  // no-overrides spawn form (rejected for required-relation archetypes)
  // cannot be proven applicable; bench archetypes carry no relations.
  const untyped: Storage = storage;
  for (let i = 0; i < n; i++) {
    spawn(untyped);
  }
  return { world, storage, n };
}

// ---------------------------------------------------------------------------
// Timing shims
// ---------------------------------------------------------------------------

/** The generator yield shape that keeps mitata's batching but drops its heap statistic. */
export interface TimedYield {
  heap: false;
  bench: () => void;
}

/**
 * Time a body under mitata's default batching, reporting time only.
 *
 * `heap: false` because the suite owns time and nothing else: memory is gated
 * separately by the allocation gate, and mitata's per-iteration heap delta is
 * GC-timing noise that would otherwise gate optimization verdicts.
 *
 * @param body - Work to time; mitata calls it many times per sample against whatever the
 * enclosing generator set up, so it must leave that state as it found it.
 * @returns The object to `yield` from a mitata generator benchmark; `bench` is `body` itself,
 * not a wrapper.
 */
export function timedBench(body: () => void): TimedYield {
  return { heap: false, bench: body };
}

/** The generator yield shape that puts mitata into manual-timing mode. */
export interface ManualYield {
  heap: false;
  manual: () => number;
}

/**
 * Time a body against a world built fresh for every iteration.
 *
 * Benches whose body consumes the world it runs against — spawning, despawning,
 * anything that leaves the population changed — cannot reuse one world across
 * samples, and mitata's default batching would replay the body thousands of
 * times per sample against a world that only survives the first. Manual mode
 * disables batching.
 *
 * `heap: false` because the heap delta would otherwise be swamped by the
 * per-iteration world construction rather than reporting what `body` allocated.
 *
 * @param build - Produces a fresh context per iteration; its cost falls outside the clock.
 * @param body - Work to time, run once per iteration against the context `build` just made; it
 * may consume the world freely.
 * @returns The object to `yield` from a mitata generator benchmark; its `manual` reports the
 * elapsed nanoseconds of `body` alone, and destroys the context's world after every call,
 * whether or not `body` threw.
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
