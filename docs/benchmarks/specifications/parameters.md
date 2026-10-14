# Benchmark parameters

## Entity counts

Every benchmark runs at `DEFAULT_N = 1000` tracked entities.

## World population

Entity, access, and batch benchmarks run against a **pre-populated world** holding `5N` entities
(`WORLD_MULTIPLIER = 5`) — five times the tracked count, four of every five being background:

- `4N` **background** entities (Health, Armor, Aggro) — idle, different archetype from tracked
- `N` **tracked** entities (Position, Velocity, Alive) — targets of the benchmark operation

Iteration benchmarks use a **bare world** (no background entities) to isolate iteration throughput
from world-size effects.

The world builder **shuffles** tracked entities (Fisher-Yates) after creation, defeating
insertion-order bias. It draws from a generator seeded at `SEED`, so the layout is identical on
every run.

## Constants

| Constant           | Value  | Purpose                                                  |
| ------------------ | ------ | -------------------------------------------------------- |
| `WORLD_MULTIPLIER` | `5`    | Pre-population multiplier for entity/access/batch worlds |
| `DT`               | `1/60` | Simulated frame delta (60 FPS) for system tick           |
| `DEFAULT_N`        | `1000` | Entity count every benchmark runs at                     |
| `SEED`             | `42`   | Shuffle seed, so every run lays entities out identically |

## Component palette

All components and tags used across the suite, organized by category.

Tracked and Background name the two archetypes of the [pre-populated world](#world-population).
Generic and Field scaling belong to the archetypes the [iteration benchmarks](iteration.md) build,
and appear nowhere else. `Shield` is the data-carrying optional of `tagArch`, which the
[`frame`](iteration.md#frame) benchmark and the allocation gate run over.

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
