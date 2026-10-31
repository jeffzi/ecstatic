# Batch (`Many`) benchmarks

Source: [`benchmarks/many-bench.ts`](../../../benchmarks/many-bench.ts)

Shared constants (`N`, the 5x world, `DT`) are defined in [parameters](parameters.md); the `sink`
accumulator is explained in [rationale](../rationale.md#conventions).

Where a batch operation has a singular counterpart among the entity benchmarks — `spawn_empty`,
`spawn_with_data`, `despawn` — the two run the same work at the same N. Reading the per-operation
numbers side by side gives the loop-versus-batch comparison directly. The rest cover forms with no
singular equivalent: clearing a whole archetype, removing a subset, spawning into a caller-owned
buffer, and despawning across archetypes.

Every body here changes the population, so the suite's `manualBench` shim rebuilds the world before
each call a sample times and destroys it after, both outside the clock. Every benchmark ends with
`destroyWorld()`.

- [spawn_empty](#spawn_empty)
- [spawn_with_data](#spawn_with_data)
- [spawn_out_reuse](#spawn_out_reuse)
- [despawn](#despawn)
- [despawn_half](#despawn_half)
- [despawn_all](#despawn_all)
- [despawn_world](#despawn_world)

## spawn_empty

**Purpose:** Measure batch entity allocation via `spawnMany`, without components.

| Property | Value                                              |
| -------- | -------------------------------------------------- |
| Setup    | Pre-populated world (5x), register empty archetype |
| Warmup   | 1000 untimed samples, a fresh world per call       |

**Operation:**

```text
sink += spawnMany(storage, N).length
```

**Rationale:** Batch counterpart to [`entity/spawn_empty`](entity.md#spawn_empty), which loops
`spawn` N times. Allocates the whole run of indices up front instead of one per entity. The delta
from [`entity/spawn_empty`](entity.md#spawn_empty) is the per-call overhead the batch form
amortizes.

---

## spawn_with_data

**Purpose:** Measure batch entity creation with component data attached at birth.

| Property | Value                                              |
| -------- | -------------------------------------------------- |
| Setup    | Pre-populated world (5x), register spawn archetype |
| Warmup   | 1000 untimed samples, a fresh world per call       |

**Operation:**

```text
sink += spawnMany(storage, N, { Position: { x: 0, y: 0 } }).length
```

**Rationale:** Batch counterpart to [`entity/spawn_with_data`](entity.md#spawn_with_data). Resolves
each component's override once for the whole batch and fills each column in one run, rather than
writing per entity. The delta from [`many/spawn_empty`](#spawn_empty) is the per-component column
write cost.

---

## spawn_out_reuse

**Purpose:** Measure batch entity creation into a caller-provided out array — the streaming form for
callers holding a reusable buffer.

| Property | Value                                                                   |
| -------- | ----------------------------------------------------------------------- |
| Setup    | Pre-populated world (5x), register spawn archetype, pre-sized out array |
| Warmup   | 1000 untimed samples, a fresh world per call                            |

**Operation:**

```text
spawnMany(storage, N, { Position: { x: 0, y: 0 } }, out)
```

**Rationale:** The out overload leaves the spawned IDs in an array the caller owns and can reuse
across calls. Bullet pools and wave spawners want this shape: they consume each call's result, and
the buffer lives on. The setup runs one full spawn-and-despawn cycle first, so the buffer is already
grown to N. The timed call then measures reuse rather than the growth it would otherwise pay for
once.

`spawnMany` writes entity IDs straight into `out`, so the saving this form promises is real: no
result array is allocated and no copy runs. That makes this benchmark the guard on the property.
Should the out path ever go back to building its own array and copying, the extra allocation and the
N-element copy would show up here as a slowdown against its own history.

One comparison to avoid: the raw delta from [`many/spawn_with_data`](#spawn_with_data) is not an
allocation measurement. The setup cycle leaves this benchmark's freelist full, so its spawns take
the recycling path. With [`BENCH_GENERATION`](parameters.md#world-population) unset,
[`many/spawn_with_data`](#spawn_with_data)'s spawns take the growth path, and that difference
dominates.

---

## despawn

**Purpose:** Measure batch removal of a list of entities.

| Property | Value                                        |
| -------- | -------------------------------------------- |
| Setup    | Pre-populated world (5x)                     |
| Warmup   | 1000 untimed samples, a fresh world per call |

**Operation:**

```text
despawnMany(storage, tracked)
```

**Rationale:** Batch counterpart to [`entity/despawn`](entity.md#despawn), which loops `despawn` N
times. Marks all IDs in one pass and back-fills freed slots from surviving tail entities where any
remain. A final pass bumps generations and pushes the freelist, leaving the 4N background entities.
The world builder shuffles the ID order to defeat sequential access. The delta from
[`entity/despawn`](entity.md#despawn) is the per-call overhead the batch phases amortize.

**Placement:** On Bun, this body reads 0.2 % slower in `many-bench.ts` than alone in a module of its
own (median of 20 processes per placement). An earlier run of 20 read equal medians for the two
placements. Compare Bun readings of this benchmark with each other, not with a copy of its body
measured elsewhere.

---

## despawn_half

**Purpose:** Measure batch removal of a subset of entities, exercising the freed-slot fill's swap
path that full-batch despawn skips.

| Property | Value                                                   |
| -------- | ------------------------------------------------------- |
| Setup    | Pre-populated world (5x), first N/2 of shuffled tracked |
| Warmup   | 1000 untimed samples, a fresh world per call            |

**Operation:**

```text
// trackedHalf = first N/2 of the shuffled tracked array
despawnMany(storage, trackedHalf)
```

**Rationale:** [`many/despawn`](#despawn) removes all N tracked entities, so the survivor boundary
drops to zero and the freed-slot fill pass is skipped outright, with no swaps and no column copies.
`despawn_half` removes N/2 entities drawn from the shuffled array, forcing roughly N/4 swaps on
average. Each swap copies every column plus the optional-bit mask and the dense entity array. The
delta from [`many/despawn`](#despawn) isolates the fill and column-copy cost that full-batch removal
skips. Compared per-entity against [`entity/despawn`](entity.md#despawn), which pays N individual
swap-and-pops, it shows the batch form's amortization under realistic partial churn.

---

## despawn_all

**Purpose:** Measure clearing an entire archetype through the no-IDs overload.

| Property | Value                                        |
| -------- | -------------------------------------------- |
| Setup    | Pre-populated world (5x)                     |
| Warmup   | 1000 untimed samples, a fresh world per call |

**Operation:**

```text
despawnMany(storage)
```

**Rationale:** The no-IDs form drops the whole dense array without swap-and-pop, bumping generations
and pushing the freelist in a single pass. The delta from [`many/despawn`](#despawn) — same entities
removed, no ID list to validate — prices the per-ID work the caller can skip when clearing
everything.

**Placement:** On Bun, this body reads 1.5 % slower in `many-bench.ts` than alone in a module of its
own (median of 20 processes per placement). An earlier run of 20 read 1.3 % slower. Compare Bun
readings of this benchmark with each other, not with a copy of its body measured elsewhere.

---

## despawn_world

**Purpose:** Measure world-scoped batch removal of IDs spanning multiple archetypes.

| Property | Value                                                                              |
| -------- | ---------------------------------------------------------------------------------- |
| Setup    | Pre-populated world (5x), 2 archetypes; N/2 IDs taken from each, shuffled together |
| Warmup   | 1000 untimed samples, a fresh world per call                                       |

**Operation:**

```text
despawnMany(world, mixed)   // N IDs interleaved across both archetypes
```

**Rationale:** The storage form trusts that every ID belongs to one storage. The world form first
makes one partition pass: it checks each ID's generation and groups the ID under its owning storage.
Then it runs the same batch compaction once per storage. It is the form for cleanup queues that hold
untyped IDs from mixed archetypes, such as level unload and deferred kill lists. The delta from
[`many/despawn`](#despawn) prices that partition pass plus the fill swaps in the half-drained
tracked storage, which the full drain skips.
