# Access benchmarks

Source: [`benchmarks/access-bench.ts`](../../../benchmarks/access-bench.ts)

Shared constants (`N`, the 5x world, `DT`) are defined in [parameters](parameters.md); the `sink`
accumulator is explained in [rationale](../rationale.md#conventions).

Entity-by-id field access via `get()` and `set()`. Unlike the view-bound field access inside
`each()` callbacks, these functions resolve an entity ID to its dense index, resolve the component
column, and perform error checks on every call — a real framework code path. Every benchmark here
uses a pre-populated world (5x) with tracked entities carrying Position (`{x, y}`), Velocity
(`{dx, dy}`), and Alive.

The world is built once per benchmark and reused across samples, because these bodies read and
overwrite fields without changing the population. Each benchmark runs its operation once untimed as
a warmup and ends with `destroyWorld()` — so every one has the same setup, and only the operation
below differs.

## get_1field

**Purpose:** Measure single-field read cost via `get(storage, id, field)`. **Operation:**

```text
for (let i = 0; i < N; i++) {
    sink += get(storage, tracked[i], Position.x)
}
```

**Rationale:** Baseline for per-entity field access outside iteration. Exercises the full resolve
chain: unpack the entity index from the ID, resolve the owning storage, read the dense index from
the sparse map, then resolve the component's column and index it. Regressions in entity resolution
or column resolution show up here.

---

## get_2field

**Purpose:** Measure the cost of reading two fields of one component from the same entity.
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

---

## get_4field

**Purpose:** Measure the cost of reading four fields spanning two components from the same entity.
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

**Purpose:** Measure single-field write cost via `set(storage, id, field, value)`. **Operation:**

```text
for (let i = 0; i < N; i++) {
    set(storage, tracked[i], Position.x, i + 1)   // value is the 1-based ordinal
}
```

**Rationale:** Write counterpart to `get_1field`. Exercises the same resolve chain plus the column
write, including the per-write check of whether the field's declared default is a boolean (booleans
are stored as 0/1). The delta from `get_1field` isolates the write-side cost. Values are stored by
reference — no cloning on this or any component write path.

---

## set_record

**Purpose:** Measure component-record write cost via `set(storage, id, Component, { fields })`.
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
record walk and the second field write against a single direct field write; the delta from
`get_2field` contrasts one entity resolve with two.
