# Access benchmarks

Source: [`benchmarks/access-bench.ts`](../../../benchmarks/access-bench.ts)

Shared constants (`N`, the 5x world, `DT`) are defined in [parameters](parameters.md); the `sink`
accumulator is explained in [rationale](../rationale.md#conventions).

Entity-by-id field access via `get()` and `set()`. Unlike the view-bound field access inside
`each()` callbacks, these functions resolve an entity ID to its dense index and resolve the
component column on every call. They also run their error checks every time, which makes this a real
framework code path. Every benchmark here uses a pre-populated world (5x) with tracked entities
carrying Position (`{x, y}`) and Velocity (`{dx, dy}`); the archetype declares the optional Alive
tag, but it is not enabled.

Each benchmark builds its world once and reuses it across samples, because these bodies read and
overwrite fields without changing the population. Every benchmark ends with `destroyWorld()`.

## get_1field

**Purpose:** Measure single-field read cost via `get(storage, id, field)`.

| Property | Value                                                   |
| -------- | ------------------------------------------------------- |
| Setup    | Pre-populated world (5x)                                |
| Warmup   | Untimed batched samples, at least 16 samples and 250 ms |

**Operation:**

```text
for (let i = 0; i < N; i++) {
    sink += get(storage, tracked[i], Position.x)
}
```

**Rationale:** Baseline for per-entity field access outside iteration. Exercises the full resolve
chain: unpack the entity index from the ID, resolve the owning storage, and read the dense index
from the sparse map. Then it resolves the component's column and indexes it. Regressions in entity
resolution or column resolution show up here.

---

## get_2field

**Purpose:** Measure the cost of reading two fields of one component from the same entity.

| Property | Value                                                   |
| -------- | ------------------------------------------------------- |
| Setup    | Pre-populated world (5x)                                |
| Warmup   | Untimed batched samples, at least 16 samples and 250 ms |

**Operation:**

```text
for (let i = 0; i < N; i++) {
    id = tracked[i]
    x = get(storage, id, Position.x)
    y = get(storage, id, Position.y)
    sink += x + y
}
```

**Rationale:** Two `get` calls against the same entity. `get` takes one field descriptor, so reading
k fields means k full resolve chains — the entity is resolved k times, not once. The delta from
`get_1field` is therefore a second complete resolve plus a second column read. Both fields belong to
the same component (Position), so the two calls resolve the same column map entry.

**Placement:** On Bun, this body reads 5.2 % faster in `access-bench.ts` than alone in a module of
its own (median of ten processes per placement). A rerun of ten more reads 2.4 % faster. Timed one
call per sample it reads 1.0 % faster, so batching does not cause it. Compare Bun readings of this
benchmark with each other, not with a copy of its body measured elsewhere.

---

## get_4field

**Purpose:** Measure the cost of reading four fields spanning two components from the same entity.

| Property | Value                                                   |
| -------- | ------------------------------------------------------- |
| Setup    | Pre-populated world (5x)                                |
| Warmup   | Untimed batched samples, at least 16 samples and 250 ms |

**Operation:**

```text
for (let i = 0; i < N; i++) {
    id = tracked[i]
    x  = get(storage, id, Position.x)
    y  = get(storage, id, Position.y)
    dx = get(storage, id, Velocity.dx)
    dy = get(storage, id, Velocity.dy)
    sink += x + y + dx + dy
}
```

**Rationale:** Four fields spanning two components (Position and Velocity). Each field descriptor
carries its own component reference, so the column lookup runs per call against two distinct
components. The delta from `get_2field` reveals whether crossing components adds overhead beyond the
per-call baseline — separate entries in the storage's column map, separate backing arrays.

---

## set_1field

**Purpose:** Measure single-field write cost via `set(storage, id, field, value)`.

| Property | Value                                                   |
| -------- | ------------------------------------------------------- |
| Setup    | Pre-populated world (5x)                                |
| Warmup   | Untimed batched samples, at least 16 samples and 250 ms |

**Operation:**

```text
for (let i = 0; i < N; i++) {
    set(storage, tracked[i], Position.x, i + 1)   // value is the 1-based ordinal
}
```

**Rationale:** Write counterpart to `get_1field`. Exercises the same resolve chain plus the column
write, including the per-write check of whether the field's declared default is a boolean (booleans
are stored as 0/1). The delta from `get_1field` isolates the write-side cost. `set` stores values by
reference: no component write path clones them.

---

## set_record

**Purpose:** Measure component-record write cost via `set(storage, id, Component, { fields })`.

| Property | Value                                                   |
| -------- | ------------------------------------------------------- |
| Setup    | Pre-populated world (5x)                                |
| Warmup   | Untimed batched samples, at least 16 samples and 250 ms |

**Operation:**

```text
for (let i = 0; i < N; i++) {
    v = i + 1   // the 1-based ordinal
    set(storage, tracked[i], Position, { x: v, y: v * 2 })
}
```

**Rationale:** The component-record overload takes a component descriptor plus a partial values
record. It resolves the entity once, then walks the record's own entries and writes each named
field, resolving the column per field. This is the general multi-field `set` path: one entity
resolve, one object walk, and a per-field column resolve. The delta from `set_1field` prices the
record walk and the second field write against a single direct field write. The delta from
`get_2field` contrasts one entity resolve with two.
