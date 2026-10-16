# Benchmark rationale

Why these benchmarks, and what each one reveals. For each benchmark's setup, measured operation, and
the code path it targets, see the [specification files](README.md#benchmark-groups); each file
states its teardown once in its intro.

---

## Overview

This is a **regression-detection benchmark suite** for ecstatic, an entity component system (ECS).
It runs on Node (V8) by default, and optionally under Bun (JavaScriptCore) via `--engine`, timed
with [mitata](https://github.com/evanwashere/mitata). The goal is catching performance regressions
between ecstatic releases, not comparing ecstatic against other ECS frameworks.

Each benchmark targets a specific ecstatic code path. A regression rarely moves a single number (a
slowdown in `each()` moves all ten iteration benchmarks), but the set that moves narrows where it
lives. A change confined to `deferred_despawn` and `many/despawn_half` points at the batch despawn
path; one that moves every `soa_*` benchmark points at the iteration view.

**Benchmarks are keyed to API forms and workload shapes, not to the current implementation.** The
suite doubles as the fixed contract for benchmark-driven optimization passes: during such a pass the
benchmark sources are off-limits, so a pass cannot make its numbers look good by editing what they
measure. A benchmark therefore earns its slot by covering a distinct API form or workload shape —
even when it currently executes nearly the same code as another. That overlap is an outcome the
suite enforces, not redundancy, and a future pass trading it away is exactly what it catches.

---

## Conventions

**World population model.** Entity, access, and batch benchmarks pre-populate the world at a 5x
multiplier: 4N background entities plus N tracked entities. The motivations:

- A realistic workload, where only ~20% of entities are actively operated on.
- Allocation pressure from the background population.
- Stable measurements reflecting production-like sparse-set density.
- Lookups that resolve against that density, rather than against a table small enough to sit
  entirely in cache — the access benchmarks measure the resolve chain, and a toy-sized world would
  hide most of its cost.

**Iteration benchmarks use bare worlds.** Entity and batch benchmarks need the populated world
because structural operations behave differently under memory pressure. Iteration benchmarks strip
out the idle background population to isolate per-entity throughput from world-size effects. Every
entity in an iteration world belongs to a storage its benchmark iterates. The frame benchmark
iterates the background storage as one of its nine storages.

**Warmup.** Priming passes run during setup and are not timed, so the measured body reflects V8's
steady state rather than one-time optimization and inline-cache warmup costs. mitata additionally
runs its own warmup samples before it starts recording.

**Sink pattern.** A module-level `sink` variable accumulates values from read-only benchmarks, and
the entry point feeds the total to mitata's `do_not_optimize` once every suite has run. Without it,
V8 may prove the loop body's results unobservable and delete it.

**Shuffle.** A Fisher-Yates shuffle on tracked entity arrays defeats insertion-order bias. Real
workloads access entities in unpredictable order; sequential access would give unrealistically
favorable cache behavior. The shuffle is driven by a seeded generator, so a given entity layout is
reproducible across runs.

**Timing lifecycle.** Only the benchmark body is timed. How the world around it is managed depends
on what the body does:

- **Net-neutral bodies** — reads, overwrites, or a despawn-then-respawn pair that restores the
  population — build one world during setup and reuse it for every sample. mitata batches these,
  replaying the body thousands of times per sample for its best resolution.
- **World-consuming bodies** — anything that leaves the population changed — run under mitata's
  manual-timing mode. The suite's own `manualBench` helper rebuilds the world before each iteration
  and destroys it after, both outside the clock, so each iteration starts from identical state.
  Manual mode also disables batching, which would otherwise replay a consuming body against a world
  that only survives the first replay.

Consuming benchmarks report no heap statistic: the per-iteration world construction would dominate
the delta rather than reporting what the body itself allocated.

**Process isolation.** Every benchmark is measured in a process of its own, so its figure carries no
residue from whatever ran before it and reading one benchmark against another is meaningful. See
[`benchmarks/README.md`](../../benchmarks/README.md) for how the runner does this and what it costs.

---

## Design decisions

**Entity-by-id get/set vs iteration-view access.** Inside `each()` callbacks, field access goes
through a view bound once per row, so a read or write costs a column lookup and an index — no entity
resolution. The field-count scaling benchmarks
([`soa_1field`](specifications/iteration.md#soa_1field)..[`soa_10field`](specifications/iteration.md#soa_10field))
cover the only variable there: how many fields the callback touches per entity. The `get()`/`set()`
functions are a different path: they unpack an entity ID to its index, validate liveness under debug
builds, and resolve the component column with its error checks, on every call. The
[access benchmarks](specifications/access.md) cover this resolve-and-read/write path with scaling
from 1 to 4 fields and both the field-descriptor and component-record `set` overloads.

**No add/remove component benchmarks.** ecstatic archetypes are static — component lists are fixed
at definition time. There are no archetype transitions and no runtime component mutation. This
eliminates an entire benchmark category that most ECS suites require.

**A clean world is not the world that ships.** Fresh, front-to-back storage is the easiest case and
the least representative one: real game worlds churn for hours, and swap-and-pop leaves the dense
array scrambled. [`post_churn_throughput`](specifications/iteration.md#post_churn_throughput)
therefore pairs with `throughput` on a deliberately fragmented world, so a regression in
swap-and-pop reorganization or freelist recycling has somewhere to show up. Inspired by the
`IteratePathological` benchmark in [EnTT](https://github.com/skypjack/entt), a C++ ECS library.

**Removing everything is a special case, so it cannot be the only one measured.** `many/despawn` and
`many/despawn_all` both clear the whole archetype, and the fill pass that back-fills freed slots is
skipped entirely when no entity survives. The pattern real games run is partial: projectile cleanup,
area-of-effect kills, wave teardown, deferred cleanup queues.
[`despawn_half`](specifications/batch.md#despawn_half) is the benchmark that actually reaches the
fill path, and its section prices the swaps and column copies involved.

**Both despawn-during-iteration idioms earn a slot.**
[`each_with_despawn`](specifications/iteration.md#each_with_despawn) despawns from inside the
iterating callback; [`deferred_despawn`](specifications/iteration.md#deferred_despawn) collects the
doomed IDs and flushes them afterwards. Real cleanup systems are written both ways and the two costs
diverge, so measuring only one would leave a regression in the other invisible. Each section covers
what its form pays for.

**The reference group is a ceiling, not a regression target.** Every other benchmark targets an
ecstatic code path; the timed bodies of the [reference benchmarks](specifications/reference.md) call
none. Each is a hand-inlined column loop, the shape a compile-time transform would emit for one
`each()` call. It pairs with the iteration benchmark it mirrors and shares that benchmark's world
builder, warmup, and timing. The gap within a pair is what such a transform would buy for that call
site, measured on the same engine in the same suite run. A reference number says little about
ecstatic by itself: read each one against its iteration twin. The
[allocation gate](../../benchmarks/README.md#allocation-gate) measures ecstatic operations such as
`each()`, and a reference body calls none, so the gate has nothing to check there.

---

## Omissions

| Omitted                        | Reason                                                                                                      |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| Component add/remove           | Static archetypes — no runtime component mutation                                                           |
| Entity-count sweeps            | Every benchmark runs at `DEFAULT_N`; scaling curves belong to a profiling pass, not to regression detection |
| Match-ratio variants           | `each()` visits every row of the storage it is given — there is no partial-match path to vary               |
| Multi-component `each` scaling | Covered by the `soa_*` family, which varies field count on one component with no dispatch difference        |
