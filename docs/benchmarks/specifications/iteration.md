# Iteration benchmarks

Source: [`benchmarks/iteration-bench.ts`](../../../benchmarks/iteration-bench.ts)

Shared constants (`N`, the 5x world, `DT`) are defined in [parameters](parameters.md); the `sink`
accumulator is explained in [rationale](../rationale.md#conventions).

Every iteration benchmark runs against a bare world — no background entities — so the numbers
reflect per-entity throughput rather than world size. `each_with_despawn` and `deferred_despawn`
consume the population they run against, so the suite's `manualBench` shim rebuilds their world
before each iteration and destroys it after, both outside the clock. The rest are net-neutral and
reuse one world. Every benchmark here ends with `destroyWorld()`.

## throughput

**Purpose:** Measure raw per-entity `each()` throughput with a minimal workload.

| Property | Value                                                  |
| -------- | ------------------------------------------------------ |
| Setup    | Bare world with N entities (Position, Velocity, Alive) |
| Warmup   | One `each()` pass                                      |

**Operation:**

```text
each(storage, (e) => {
    e.Position.x += e.Velocity.dx * DT
    e.Position.y += e.Velocity.dy * DT
})
```

**Rationale:** Establishes the iteration baseline. One archetype, every entity visited, two field
reads and two writes per entity. Overhead beyond the arithmetic is `each()` dispatch and view
rebinding. The fused twin is [`fused_throughput`](reference.md#fused_throughput).

---

## post_churn_throughput

**Purpose:** Measure `each()` iteration throughput on a world fragmented by sustained entity churn.

| Property | Value                                                  |
| -------- | ------------------------------------------------------ |
| Setup    | Bare world with N entities (Position, Velocity, Alive) |
| Warmup   | One `each()` pass, after the churn                     |

**Setup detail:** After the initial spawn, runs 5 churn rounds. Each round collects every 3rd entity
via `each()`, despawns them, then respawns the same count. This scrambles dense array ordering via
swap-and-pop and exercises freelist recycling without changing the final entity count.

**Operation:**

```text
each(storage, (e) => {
    e.Position.x += e.Velocity.dx * DT
    e.Position.y += e.Velocity.dy * DT
})
```

**Rationale:** Identical body to `throughput` but on a heavily churned world. Detects regressions
where swap-and-pop reorganization or generational ID recycling degrades iteration performance. A
delta from `throughput` indicates the dense array develops cache-unfriendly patterns under sustained
churn. Inspired by the `IteratePathological` benchmark in EnTT, a C++ ECS library.

---

## frame

**Purpose:** Measure a frame of nine `each()` systems, one per archetype, run back to back.

| Property | Value                                                                    |
| -------- | ------------------------------------------------------------------------ |
| Setup    | Bare world, N default-valued entities in each of the nine storages below |
| Warmup   | One frame                                                                |

**Setup detail:** The nine archetypes and the system run over each, in frame order:

| Archetype     | Components                        | System                                            |
| ------------- | --------------------------------- | ------------------------------------------------- |
| `trackedArch` | Position, Velocity, Alive (opt.)  | the `throughput` body                             |
| `bgArch`      | Health, Armor, Aggro (opt.)       | `hp += def * DT`                                  |
| `spawnArch`   | Position, Alive (opt.)            | `x += DT`                                         |
| `tagArch`     | Position, Alive and Shield (opt.) | `y += x * DT`                                     |
| `chainArch`   | A, B, C, D, E                     | `B.v += A.v * DT`, `D.v += C.v * DT`, `E.v += DT` |
| `soa1Arch`    | F1                                | `a += DT`                                         |
| `soa2Arch`    | F2                                | `a += b * DT`                                     |
| `soa5Arch`    | F5                                | `a += b * DT`, `c += d * DT`, `e += DT`           |
| `soa10Arch`   | F10                               | `a += b * DT`, `c += d * DT`, ..., `i += j * DT`  |

**Operation:**

```text
throughput(tracked); heal(bg); drift(spawn); climb(tag); chain(chain)
soa1(soa1); soa2(soa2); soa5(soa5); soa10(soa10)
# each system is one each(storage, (e) => ...) call with the update above
```

**Rationale:** The other iteration benchmarks time one or a few callbacks over one archetype, so the
callback call inside `each()` sees at most a handful of callbacks and a single view shape. A real
frame runs many systems through that same call. Here it sees nine callbacks and nine view shapes, so
a regression in how `each()` copes with a varied caller shows up here first. Every update adds `DT`,
or a field the system never writes times `DT`, so no value shrinks toward the subnormal range,
however many times mitata replays the frame. The fused twin is
[`fused_frame`](reference.md#fused_frame).

---

## each_chained

**Purpose:** Measure per-pass overhead when 4 sequential `each()` calls propagate values A → B → C →
D → E.

| Property | Value                                      |
| -------- | ------------------------------------------ |
| Setup    | Bare world, N entities with components A-E |
| Warmup   | One `each()` pass (A → B)                  |

**Operation:**

```text
each(storage, (e) => e.B.v = e.A.v)
each(storage, (e) => e.C.v = e.B.v)
each(storage, (e) => e.D.v = e.C.v)
each(storage, (e) => e.E.v = e.D.v)
```

**Rationale:** Four `each()` passes over the same archetype measure per-call dispatch overhead and
whether writes from one pass are visible to the next within the same frame. Because the archetype
carries five components, the bound view is wider than `throughput`'s — the pair brackets how view
width affects per-entity cost.

---

## each_with_despawn

**Purpose:** Measure `each()` iteration cost when every other entity is despawned mid-iteration.

| Property | Value                                                  |
| -------- | ------------------------------------------------------ |
| Setup    | Bare world with N entities (Position, Velocity, Alive) |
| Warmup   | One read-only `each()` pass                            |

**Operation:**

```text
let count = 0
each(storage, (e) => {
    count += 1
    if (count % 2 === 0) {
        despawn(storage, e.id)
    }
})
sink += count
```

**Rationale:** `each()` walks rows from the last to the first, which is what makes despawning during
iteration safe: swap-and-pop moves a row the traversal has already passed. This benchmark drives
that path under load, so a regression in the traversal's swap-and-pop handling shows up as a timing
change. It measures only cost; the unit tests own the correctness of the traversal.

---

## deferred_despawn

**Purpose:** Measure the deferred-cleanup idiom — collect dead entities during `each()`, then flush
them with one batch `despawnMany()` after the loop.

| Property | Value                                                  |
| -------- | ------------------------------------------------------ |
| Setup    | Bare world with N entities (Position, Velocity, Alive) |
| Warmup   | One collect + flush cycle, then a respawn back to N    |

**Operation:**

```text
// dead: buffer reused across iterations, emptied after each flush

let seen = 0
each(storage, (e) => {
    seen += 1
    if (seen % 2 === 0) {
        dead.push(e.id)
    }
})
despawnMany(storage, dead)
dead.length = 0
```

**Rationale:** `each_with_despawn` pins inline despawn during iteration; this benchmark pins the
collect-then-flush alternative, where systems mark the dead into a reused buffer and a cleanup pass
flushes them after the loop. The buffer is emptied after each flush rather than replaced, which is
required for correctness: IDs left behind would be handed to the next iteration's `despawnMany` as
already-dead entities. The flush input is also what distinguishes this from
[`many/despawn_half`](batch.md#despawn_half). That benchmark shuffles its ID list to defeat
sequential access, while IDs collected during `each()` arrive in descending dense order, so the
flush's generation checks and freelist pushes walk the entity arrays sequentially — the input shape
this idiom actually produces in a frame.

---

## soa_1field

**Purpose:** Measure field-read throughput for a 1-field component.

| Property | Value                          |
| -------- | ------------------------------ |
| Setup    | Bare world, N entities with F1 |
| Warmup   | One `each()` pass              |

**Operation:**

```text
each(storage, (e) => sink += e.F1.a)
```

**Rationale:** Baseline for field-access scaling. One array read per entity establishes the minimum
per-field cost.

---

## soa_2field

**Purpose:** Measure field-read throughput for a 2-field component.

| Property | Value                          |
| -------- | ------------------------------ |
| Setup    | Bare world, N entities with F2 |
| Warmup   | One `each()` pass              |

**Operation:**

```text
each(storage, (e) => sink += e.F2.a + e.F2.b)
```

**Rationale:** Two array reads per entity. The delta from `soa_1field` isolates per-field overhead
from per-entity overhead.

---

## soa_5field

**Purpose:** Measure field-read throughput for a 5-field component.

| Property | Value                          |
| -------- | ------------------------------ |
| Setup    | Bare world, N entities with F5 |
| Warmup   | One `each()` pass              |

**Operation:**

```text
each(storage, (e) => sink += e.F5.a + e.F5.b + e.F5.c + e.F5.d + e.F5.e)
```

**Rationale:** Five array reads per entity. Tests whether per-field cost stays constant or shows
cache-line effects as field count grows.

---

## soa_10field

**Purpose:** Measure field-read throughput for a 10-field component.

| Property | Value                           |
| -------- | ------------------------------- |
| Setup    | Bare world, N entities with F10 |
| Warmup   | One `each()` pass               |

**Operation:**

```text
each(storage, (e) => sink += e.F10.a + e.F10.b + ... + e.F10.j)
```

**Rationale:** Ten array reads per entity, one from each of ten separate column arrays. Completes
the field-count scaling curve from 1 to 10.
