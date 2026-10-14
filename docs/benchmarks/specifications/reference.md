# Reference benchmarks

Source: [`benchmarks/reference-bench.ts`](../../../benchmarks/reference-bench.ts), with the loop
bodies in [`benchmarks/systems.ts`](../../../benchmarks/systems.ts)

Shared constants (`N`, `DT`) are defined in [parameters](parameters.md). Why this group exists, and
why its numbers are not regression targets, is in [rationale](../rationale.md#design-decisions).

Each benchmark here is the twin of an [iteration benchmark](iteration.md): the same world builder,
the same warmup, and the same batched timing, through one shared helper. Only the timed body
differs. Where the iteration benchmark calls `each()`, the reference runs the loop a compile-time
transform would emit for that call:

- It reads the column arrays it needs from the storage once per call, never caching them across
  calls, because storage growth replaces typed-array columns.
- It walks rows from `storage.n - 1` down to 0, the order `each()` visits them.
- It does the same arithmetic as the `each()` callback, and calls no `each()`, `query()`, `get()`,
  or `set()`.

Each fused body's doc comment names the `each()` body it mirrors. A test runs every fused body and
its `each()` twin over identically seeded worlds, including across storage growth, and requires the
columns to come out bitwise identical, so a reference loop cannot win by doing less work. Both
benchmarks are net-neutral and reuse one world, and both end with `destroyWorld()`.

## fused_throughput

**Purpose:** Measure the fused-loop ceiling for [`throughput`](iteration.md#throughput).

| Property | Value                                                  |
| -------- | ------------------------------------------------------ |
| Setup    | Bare world with N entities (Position, Velocity, Alive) |
| Warmup   | One pass                                               |

**Operation:**

```text
x, y = columns(Position.x, Position.y)
dx, dy = columns(Velocity.dx, Velocity.dy)
for i from storage.n - 1 down to 0:
    x[i] += dx[i] * DT
    y[i] += dy[i] * DT
```

**Rationale:** The gap between `throughput` and this benchmark is the per-entity cost of `each()`
dispatch and view rebinding on a single callback: what fusing one monomorphic call site buys.

---

## fused_frame

**Purpose:** Measure the fused-loop ceiling for [`frame`](iteration.md#frame).

| Property | Value                                                                    |
| -------- | ------------------------------------------------------------------------ |
| Setup    | Bare world, N default-valued entities in each of the nine frame storages |
| Warmup   | One frame                                                                |

**Operation:**

```text
fused_throughput(tracked); fused_heal(bg); fused_drift(spawn); fused_climb(tag); fused_chain(chain)
fused_soa1(soa1); fused_soa2(soa2); fused_soa5(soa5); fused_soa10(soa10)
# each one the column loop for the matching frame system, in the same order
```

**Rationale:** The gap between `frame` and this benchmark is what fusing every system of a frame
buys once the `each()` call site serves nine callbacks and nine view shapes. Each fused loop is its
own call site, so none of them shares that cost.
