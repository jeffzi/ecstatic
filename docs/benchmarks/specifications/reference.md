# Reference benchmarks

Source: [`benchmarks/reference-bench.ts`](../../../benchmarks/reference-bench.ts), with the loop
bodies in [`benchmarks/systems.ts`](../../../benchmarks/systems.ts)

Shared constants (`N`, `DT`) are defined in [parameters](parameters.md). Why this group exists, and
why its numbers are not regression targets, is in [rationale](../rationale.md#design-decisions).

Each benchmark here is the twin of an [iteration benchmark](iteration.md): the same world builder,
the same warmup, and the same batched timing, through one shared helper. Only the timed body
differs. Where the iteration benchmark calls `each()`, the reference benchmark runs the inlined loop
a build-time optimizer would emit for that call:

- It reads the column arrays it needs from the storage once per call, never caching them across
  calls, because storage growth replaces typed-array columns.
- It walks rows from `storage.n - 1` down to 0, the order `each()` visits them.
- It does the same arithmetic as the `each()` callback, and calls no `each()`, `query()`, `get()`,
  or `set()`.

Each inlined loop's doc comment names the `each()` body it mirrors.
`tests/benchmarks/systems.test.ts` runs every inlined loop and its `each()` twin over identically
seeded worlds, including across storage growth. It requires the columns to come out bitwise
identical, so an inlined loop cannot win by doing less work. Both reference benchmarks are
[net-neutral](../rationale.md#conventions) and reuse one world, and both end with `destroyWorld()`.

## inlined_throughput

**Purpose:** Measure the inlined-loop ceiling for [`throughput`](iteration.md#throughput).

| Property | Value                                           |
| -------- | ----------------------------------------------- |
| Setup    | Bare world with N entities (Position, Velocity) |
| Warmup   | One pass                                        |

**Operation:**

```text
x, y = columns(Position.x, Position.y)
dx, dy = columns(Velocity.dx, Velocity.dy)
for i from storage.n - 1 down to 0:
    x[i] += dx[i] * DT
    y[i] += dy[i] * DT
```

**Rationale:** The gap between `throughput` and this benchmark is what inlining one `each()` call
with a single callback buys: the per-entity cost of `each()` dispatch and view rebinding.

---

## inlined_frame

**Purpose:** Measure the inlined-loop ceiling for [`frame`](iteration.md#frame).

| Property | Value                                                                    |
| -------- | ------------------------------------------------------------------------ |
| Setup    | Bare world, N default-valued entities in each of the nine frame storages |
| Warmup   | One frame                                                                |

**Operation:**

```text
inlined_throughput(tracked); inlined_heal(bg); inlined_drift(spawn); inlined_climb(tag); inlined_relay(chain)
inlined_tick(soa1); inlined_accrue(soa2); inlined_pulse(soa5); inlined_sweep(soa10)
# each one the inlined loop for the matching frame system, in the same order
```

**Rationale:** The gap between `frame` and this benchmark is what inlining every system of a frame
buys. In `frame`, the callback call site inside `each()` serves nine callbacks and nine view shapes.
Each inlined loop is separate code with no shared callback call site.
