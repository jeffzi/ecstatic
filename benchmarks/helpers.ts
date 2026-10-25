import {
  createWorld,
  despawnMany,
  type EntityId,
  register,
  type Storage,
  spawn,
  spawnMany,
  type World,
} from "ecstatic";

import {
  bgArch,
  chainArch,
  soa1Arch,
  soa2Arch,
  soa5Arch,
  soa10Arch,
  spawnArch,
  tagArch,
  trackedArch,
} from "./archetypes.js";
import type { BenchLifecycle } from "./measure.js";
import { mulberry32, shuffle } from "./random.js";
import { parseGeneration } from "./runner.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Total population is this multiple of N: 1 tracked entity per 4 background ones. */
const WORLD_MULTIPLIER = 5;

/** Fixed timestep, so movement integration matches a 60 Hz frame. */
export const DT = 1 / 60;

export const DEFAULT_N = 1000;

/** Seed for every world build — benchmarks must lay entities out identically on every run. */
const SEED = 42;

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

interface CreateOpts {
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
 * The accepted range is 1 to 1023. A slot has 1,023 generations, so a larger
 * value would wrap and measure a lower generation than the one asked for.
 *
 * @param opts - `noBackground: true` skips the 4N background entities, isolating the tracked
 * archetype; the default builds them.
 * @returns The world, its tracked storage, and `n` (always `DEFAULT_N`); the caller owns the
 * world and nothing here releases it. `tracked` holds the N ids shuffled so index order does not
 * match row order — random-access benchmarks would otherwise walk the storage front to back and
 * measure a prefetch-friendly pattern no real workload has.
 * @throws UsageError when `BENCH_GENERATION` is set to anything but an integer from 1 to 1023.
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

/**
 * Build the world the throughput benchmarks run over: `benchCreateWorld` with no background
 * population.
 *
 * `iteration/throughput`, `iteration/post_churn_throughput`, `iteration/helper_call` and the
 * inlined twin of `iteration/throughput` all take their world from here, so they cannot drift
 * onto different worlds.
 *
 * @returns The world, its tracked storage, the shuffled tracked ids, and `n` (always
 * `DEFAULT_N`); the caller owns the world and nothing here releases it.
 * @throws UsageError when `BENCH_GENERATION` is set to anything but an integer from 1 to 1023.
 */
export function makeThroughputWorld(): BenchCtx<typeof trackedArch> {
  return benchCreateWorld({ noBackground: true });
}

/**
 * Build a world holding nothing but `DEFAULT_N` default-valued entities of one archetype.
 *
 * @param arch - Archetype to register and spawn from; it must declare no required relation,
 * since every entity is spawned with no overrides.
 * @returns The world and the registered storage for `arch`; the caller owns the world and nothing
 * here releases it.
 */
export function makeBareWorld<A extends AnyArchetype>(
  arch: A,
): { world: World; storage: Storage<A> } {
  const world = createWorld();
  return { world, storage: registerDefaults(world, arch) };
}

/** The frame world and its nine storages, each holding `DEFAULT_N` default-valued entities. */
export interface FrameCtx {
  world: World;
  tracked: Storage<typeof trackedArch>;
  bg: Storage<typeof bgArch>;
  spawn: Storage<typeof spawnArch>;
  tag: Storage<typeof tagArch>;
  chain: Storage<typeof chainArch>;
  soa1: Storage<typeof soa1Arch>;
  soa2: Storage<typeof soa2Arch>;
  soa5: Storage<typeof soa5Arch>;
  soa10: Storage<typeof soa10Arch>;
}

/**
 * Build the world a frame of systems runs over: nine archetypes, `DEFAULT_N` default-valued
 * entities in each, and no other entity.
 *
 * Takes no entity count, for the same reason `benchCreateWorld` takes none: a frame benchmark and
 * its inlined twin must measure the same world.
 *
 * @returns The world and its nine storages; the caller owns the world and nothing here releases
 * it.
 */
export function makeFrameWorld(): FrameCtx {
  const world = createWorld();
  return {
    world,
    tracked: registerDefaults(world, trackedArch),
    bg: registerDefaults(world, bgArch),
    spawn: registerDefaults(world, spawnArch),
    tag: registerDefaults(world, tagArch),
    chain: registerDefaults(world, chainArch),
    soa1: registerDefaults(world, soa1Arch),
    soa2: registerDefaults(world, soa2Arch),
    soa5: registerDefaults(world, soa5Arch),
    soa10: registerDefaults(world, soa10Arch),
  };
}

/**
 * Register `arch` in `world` and fill its storage with `DEFAULT_N` default-valued entities.
 *
 * @param world - World to register the archetype in.
 * @param arch - Archetype to register and spawn from; it must declare no required relation,
 * since every entity is spawned with no overrides.
 * @returns The registered storage, holding `DEFAULT_N` entities.
 */
function registerDefaults<A extends AnyArchetype>(world: World, arch: A): Storage<A> {
  const storage = register(world, arch);
  // Widened to bare Storage: the generic A is unresolved here, so the
  // no-overrides spawn form (rejected for required-relation archetypes)
  // cannot be proven applicable; bench archetypes carry no relations.
  const untyped: Storage = storage;
  spawnMany(untyped, DEFAULT_N);
  return storage;
}

// ---------------------------------------------------------------------------
// Benchmark descriptions
// ---------------------------------------------------------------------------

/**
 * Describe a benchmark whose body leaves its world as it found it: one build, then every warmup
 * and timed call over the same context.
 *
 * Benchmarks that must match, such as an `each()` benchmark and its inlined twin, pass the same
 * `build`, so they can differ only in the body they time.
 *
 * @param build - Builds the context the body runs over; called once per measurement, outside the
 * clock.
 * @param body - The pass to time; it receives the same context for the warmup and every sample,
 * so it must leave that context as it found it.
 * @returns A warmed description carrying `build` and `body`; neither runs until it is measured.
 */
export function warmedBench<C extends { world: World }>(
  build: () => C,
  body: (ctx: C) => void,
): BenchLifecycle<C> {
  return { kind: "warmed", build, body };
}

/**
 * Describe a benchmark whose body consumes the world it runs against — spawning, despawning,
 * anything that leaves the population changed — so every sample builds its own.
 *
 * @param build - Produces a fresh context per sample; its cost falls outside the clock.
 * @param body - Work to time, run once per sample against the context `build` just made; it may
 * consume the world freely.
 * @returns A manual description carrying `build` and `body`; neither runs until it is measured.
 */
export function manualBench<C extends { world: World }>(
  build: () => C,
  body: (ctx: C) => void,
): BenchLifecycle<C> {
  return { kind: "manual", build, body };
}
