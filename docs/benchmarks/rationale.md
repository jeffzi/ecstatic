# Benchmark rationale

Why these benchmarks, and what each one reveals. For each benchmark's setup, measured operation, and
the code path it targets, see the [specification files](README.md#benchmark-groups); each file
states its teardown once in its intro.

---

## Overview

This is a **regression-detection benchmark suite** for ecstatic, an entity component system (ECS).
It runs on Node (V8) by default, and optionally under Bun (JavaScriptCore) via `--engine`, timed
with [tinybench](https://github.com/tinylibs/tinybench). The goal is catching performance
regressions between ecstatic releases, not comparing ecstatic against other ECS frameworks.

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

**Warmup.** tinybench runs untimed warmup samples before it records any, so the measured body
reflects the engine's steady state rather than one-time optimization and inline-cache warmup costs.
A net-neutral benchmark warms up on its one world for at least 16 samples and 250 ms. After each
warmup sample shorter than 200 timer steps, warmup scales the calls per sample by how far short the
sample fell, so the count lands near 200 steps, and every timed sample reuses the count warmup ended
with. A world-consuming benchmark warms up for 1000 samples and scales its calls per sample the same
way, each call on a fresh world.

**Sink pattern.** A module-level `sink` variable accumulates values from read-only benchmarks. Once
the benchmark has run, the entry point stores the sink of the measured benchmark's own suite in
`globalThis.benchSink`, where it stays readable. tinybench keeps no sink of its own, so the suite
owns this one. Without it, V8 may prove the loop body's results unobservable and delete it.

**Shuffle.** A Fisher-Yates shuffle on tracked entity arrays defeats insertion-order bias. Real
workloads access entities in unpredictable order; sequential access would give unrealistically
favorable cache behavior. The shuffle is driven by a seeded generator, so a given entity layout is
reproducible across runs.

**Timing lifecycle.** The driver (`benchmarks/measure.ts`) times only the benchmark body, through
tinybench's synchronous sampler, so no sampling loop wraps the timed code in an `async` function.
How the world around it is managed depends on what the body does:

- **Net-neutral bodies** leave the population as they found it: reads, overwrites, or a
  despawn-then-respawn pair. They build one world during setup, run the body untimed during warmup,
  and reuse that world for every sample. Each sample times a fixed number of consecutive calls of
  the body and reports the sample's span divided by that count. The driver destroys the world once
  timing ends.
- **World-consuming bodies** — anything that leaves the population changed — get a fresh world for
  every call. Each sample times its count of calls one at a time: the suite's own `manualBench`
  helper builds a world before each call, and the driver destroys it after. Both happen outside the
  clock, even when the body throws, so each call starts from identical state. The sample reports the
  sum of its calls' spans divided by the count. These benchmarks run fixed sample counts, 1000
  warmup and 2000 timed, whatever the count, instead of a time budget. tinybench counts only the
  clocked span toward its time budget, and the untimed builds in each sample scale with its count,
  so a time budget would multiply a benchmark's wall time; even with fixed counts, wall time grows
  with the count.

The driver collects garbage once, after warmup and before the first timed sample, never inside a
sample. Under Bun it passes the sample function, never the body, to `noInline` from `bun:jsc`, so
JavaScriptCore keeps the sample function out of the sampling loop it compiles.

Batching a net-neutral body is sound only while the loop that repeats it times like a plain loop. A
benchmark library's own batching loop can be the code the optimizing compiler works on. A batched
reading then depends on how that loop compiles around the body, not on the body alone. The same
function reads differently in its own module than copied into another. The driver therefore repeats
the body inside the sample function, a loop that times like a plain loop on both engines. Measured
over 15 to 20 processes, the [`throughput`](specifications/iteration.md#throughput) body batched
this way read 1139 ns against a plain loop's 1110 ns on Node, and 605 ns against 602 ns on Bun. A
change that loses that match brings back the placement effect that the placement rule rejects.

Batching is what buys resolution. `performance.now()` advances in steps, about 41.7 ns under both
Node and Bun on the Apple M2 Max the suite was measured on. The driver measures the step at startup
rather than assuming it, and warmup sizes every body's count so a sample spans at least 200 steps,
which keeps one step at most 0.5 % of the span. A body that already spans 200 steps runs once per
sample. A net-neutral sample times its calls back to back; a world-consuming sample sums the spans
of its calls, each on a fresh world.

A batched reading is the median over samples of each sample's span divided by its count. That
average takes in the slow tail a single call's median leaves out, so a benchmark whose count is
above 1 reads higher than the median of one call: about 7.5 % for `many/despawn_all` on Bun, a body
near 1.1 µs. A change in count therefore moves a benchmark's reading even when the body's cost is
unchanged.

**Placement rule.** A change to how bodies are timed must not make placement matter. Identical code
timed in its home module and alone in a module of its own must not read further apart than
process-to-process variation allows. Judge it over ten processes per placement, running each home
process and its minimal counterpart back to back and testing the paired differences, on every engine
the suite runs. Reject a change that adds such a placement effect unless it removes more effects
across the suite than it adds. A change may leave an existing effect in place. Record every
remaining effect in its benchmark's specification.

Consuming benchmarks report no heap statistic: the per-call world construction would dominate the
delta rather than reporting what the body itself allocated.

**Process isolation.** Every benchmark is measured in a process of its own, so its figure carries no
residue from whatever ran before it and reading one benchmark against another is meaningful. Before
it measures, the process loads only the driver and the suite of the benchmark it measures, because
on Bun code loaded in the process slows a reading even when none of it runs: with every suite and
the code that spawns children loaded, `many/despawn_all` read about 3–4 % and `many/despawn` about 1
% slower. Even so, those two still read about 1.5 % and 0.2 % slower than alone in a module of their
own, as the [`despawn_all`](specifications/batch.md#despawn_all) and
[`despawn`](specifications/batch.md#despawn) specifications record. See
[`benchmarks/README.md`](../../benchmarks/README.md) for how the runner does this and what it costs.

---

## Design decisions

**Entity-by-id get/set vs iteration-view access.** Inside `each()` callbacks, field access goes
through a view bound once per row, so a read or write costs a column lookup and an index — no entity
resolution. The field-count scaling benchmarks
([`soa_1field`][soa-1field]..[`soa_10field`][soa-10field]) cover the only variable there: how many
fields the callback touches per entity. The `get()`/`set()` functions are a different path: they
unpack an entity ID to its index, validate liveness under debug builds, and resolve the component
column with its error checks, on every call. The [access benchmarks](specifications/access.md) cover
this resolve-and-read/write path with scaling from 1 to 4 fields and both the field-descriptor and
component-record `set` overloads.

[soa-1field]: specifications/iteration.md#soa_1field
[soa-10field]: specifications/iteration.md#soa_10field

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
none. Each is a hand-inlined column loop, the shape a build-time optimizer would emit for one
`each()` call. It pairs with the iteration benchmark it mirrors and shares that benchmark's world
builder, warmup, and timing. The gap within a pair is what such an optimizer would buy for that call
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
