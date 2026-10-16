# Benchmark parameters

Constants, world population, and the component palette shared by every benchmark group. Each
specification file links here instead of repeating them.

## Entity counts

Every benchmark runs at `DEFAULT_N = 1000` tracked entities.

## World population

Entity, access, and batch benchmarks run against a **pre-populated world** holding `5N` entities
(`WORLD_MULTIPLIER = 5`) — five times the tracked count, four of every five being background:

- `4N` **background** entities (Health, Armor; optional Aggro declared, not enabled): idle,
  different archetype from tracked
- `N` **tracked** entities (Position, Velocity; optional Alive declared, not enabled): targets of
  the benchmark operation

Iteration benchmarks use a **bare world** (no idle background population: every entity belongs to a
storage the benchmark iterates) to isolate iteration throughput from world-size effects.

The world builder shuffles the `tracked` ID array (Fisher-Yates) after creation, so walking
`tracked` in order does not walk storage rows in order. Storage rows stay in insertion order. The
shuffle draws from a generator seeded at `SEED`, so the layout is identical on every run.

By default every ID is at generation 1 and the freelist is empty. Setting `BENCH_GENERATION=<n>`
recycles the tracked slots until every tracked ID is at generation `n`. It also leaves `DEFAULT_N`
free slots on the world freelist, so every benchmark that spawns draws recycled slots. Background
entities stay at generation 1. See [`benchmarks/README.md`](../../../benchmarks/README.md).

## Constants

| Constant           | Value  | Purpose                                                      |
| ------------------ | ------ | ------------------------------------------------------------ |
| `WORLD_MULTIPLIER` | `5`    | Pre-population multiplier for entity/access/batch worlds     |
| `DT`               | `1/60` | Simulated frame delta (60 frames per second) for system tick |
| `DEFAULT_N`        | `1000` | Entity count every benchmark runs at                         |
| `SEED`             | `42`   | Shuffle seed, so every run lays entities out identically     |

## Component palette

All components and tags used across the suite, organized by category.

Tracked and Background name the two archetypes of the [pre-populated world](#world-population).
Generic and Field scaling belong to the archetypes the [iteration benchmarks](iteration.md) and
their [reference twins](reference.md) build, and appear nowhere else. `Shield` is the data-carrying
optional of `tagArch`, which [`frame`](iteration.md#frame), its twin
[`inlined_frame`](reference.md#inlined_frame), and the allocation gate run over.

| Category      | Components              | Fields                                   |
| ------------- | ----------------------- | ---------------------------------------- |
| Tracked       | `Position`, `Velocity`  | `{x, y}`, `{dx, dy}`                     |
| Tracked       | `Alive`                 | (0-field, optional)                      |
| Background    | `Health`, `Armor`       | `{hp}`, `{def}`                          |
| Background    | `Aggro`                 | (0-field, optional)                      |
| Generic       | `A`, `B`, `C`, `D`, `E` | `{v}` each                               |
| Field scaling | `F1`, `F2`, `F5`, `F10` | 1/2/5/10 fields (`{a}` through `{a..j}`) |
| Optional data | `Shield`                | `{hp}` (optional)                        |

The `F*` components back the `soa_*` benchmarks, named for the structure-of-arrays layout ecstatic
stores components in: each field is its own column array, so touching `k` fields of one component
means reading from `k` separate arrays.

## Indexing convention

All pseudocode in these specification files uses 0-based indexing with `[i]` notation, matching the
source. Where a benchmark writes a 1-based ordinal rather than the loop index — `set_1field` and
`set_record` — a comment on the pseudocode line says so.
