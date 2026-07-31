# Entity benchmarks

Source: [`benchmarks/entity-bench.ts`](../../../benchmarks/entity-bench.ts)

Shared constants (`N`, the 5x world, `DT`) are defined in [parameters](parameters.md); the `sink`
accumulator is explained in [rationale](../rationale.md#conventions).

Single-entity lifecycle calls, one at a time. No benchmark here uses a warmup pass. `spawn_recycle` and `alive_check` leave the population
as they found it and reuse one world across samples. The rest change it, so the suite's
`manualBench` shim rebuilds their world before each iteration and destroys it after, both outside
the clock. Every benchmark here ends with `destroyWorld()`.

## spawn_empty

**Purpose:** Measure bare entity allocation cost, without components.

| Property | Value                                              |
| -------- | -------------------------------------------------- |
| Setup    | Pre-populated world (5x), register empty archetype |

**Operation:**

```text
for (let i = 0; i < N; i++) {
    sink += spawn(storage)
}
```

**Rationale:** Isolates entity slot allocation and generational ID assignment from component storage
cost. Regressions here indicate overhead in the sparse set or freelist path.

---

## spawn_with_data

**Purpose:** Measure entity creation cost with component data attached at birth.

| Property | Value                                              |
| -------- | -------------------------------------------------- |
| Setup    | Pre-populated world (5x), register spawn archetype |

**Operation:**

```text
for (let i = 0; i < N; i++) {
    sink += spawn(storage, { Position: { x: 0, y: 0 } })   // fresh literal per call
}
```

**Rationale:** Measures allocation plus column writes for one component. The delta from
`spawn_empty` reveals per-component initialization cost.

---

## spawn_indirect

**Purpose:** Measure entity creation cost when the overrides object is allocated once and reused,
rather than rebuilt per call.

| Property | Value                                              |
| -------- | -------------------------------------------------- |
| Setup    | Pre-populated world (5x), register spawn archetype |

**Operation:**

```text
overrides = { Position: { x: 0, y: 0 } }   // allocated once, inside the timed body
for (let i = 0; i < N; i++) {
    sink += spawn(storage, overrides)
}
```

**Rationale:** Identical workload to `spawn_with_data` except for where the overrides object comes
from. `spawn_with_data` builds a fresh nested literal on every call; this benchmark hoists it out of the
loop. The delta is what constructing those objects costs — two allocations per spawn that the caller
can avoid entirely. The hoist stays inside the timed body, so the one allocation it does make is
still counted.

---

## despawn

**Purpose:** Measure entity removal cost via swap-and-pop deletion.

| Property | Value                    |
| -------- | ------------------------ |
| Setup    | Pre-populated world (5x) |

**Operation:**

```text
for (let i = 0; i < N; i++) {
    despawn(storage, tracked[i])
}
```

**Rationale:** Entities leave a world that remains populated. Exercises sparse set swap-and-pop,
generation increment, and freelist push. Order is shuffled to defeat sequential access patterns.

---

## spawn_recycle

**Purpose:** Measure entity ID recycling through despawn-then-respawn.

| Property | Value                    |
| -------- | ------------------------ |
| Setup    | Pre-populated world (5x) |

**Operation:**

```text
for (let i = 0; i < N; i++) {
    despawn(storage, tracked[i])
}
for (let i = 0; i < N; i++) {
    tracked[i] = spawn(storage)
}
sink += tracked[N - 1]
```

**Rationale:** Forces the freelist to fill and drain in sequence. The respawn phase reuses freed
slots with incremented generations, exercising the last-in-first-out freelist pop path under
pressure. The pair is net-neutral — the population it ends with is the population it started with —
so the tracked array is rewritten in place and the next sample runs against the recycled IDs.

---

## alive_check

**Purpose:** Measure generational alive-check cost on a mixed array of live and stale IDs.

| Property | Value                                                          |
| -------- | -------------------------------------------------------------- |
| Setup    | Pre-populated world (5x), create N extra entities then despawn |

**Operation:**

```text
// mixed = shuffle(N live IDs + N stale IDs)
for (let i = 0; i < 2 * N; i++) {
    if (alive(storage, mixed[i])) {
        sink += 1
    }
}
```

**Rationale:** Half the IDs are stale (generation mismatch). Tests the generational ID check path
with unpredictable branch patterns, preventing branch prediction from hiding lookup cost. The
world-scoped `alive(world, id)` overload needs no separate benchmark: both forms share one implementation
— a single generation-array compare keyed by the unpacked entity index — so this benchmark pins that path
for both.
