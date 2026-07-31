# Benchmarks

Regression-detection benchmarks for ecstatic, timed with [mitata](https://github.com/evanwashere/mitata).

For what each benchmark measures and why, see [`docs/benchmarks/`](../docs/benchmarks/README.md).
This file covers running the suite and how much of the original Lua suite it currently covers.

## Running

`npm run bench:once` runs the suite once and prints one JSON report covering every benchmark:

```bash
npm run bench:once
```

The script builds before it runs: bare `"ecstatic"` imports resolve through the package's own
`exports` map to `dist/`, so the suite measures the last compiled output. The underlying runner is
`npx tsx --expose-gc benchmarks/main.ts`.

Pass a pattern after `--` to run a subset; the pattern is an unanchored regular expression matched
against benchmark names:

```bash
npm run bench:once -- '^iteration\.'   # one group
npm run bench:once -- 'soa'            # anywhere in the name
```

A pattern that matches nothing is an error, not an empty report. A pattern cannot begin with `-`,
which would parse as a flag.

The suite requires an exposed garbage collector and exits non-zero without one, because mitata would
otherwise substitute a fallback that allocates a 1 GiB buffer per benchmark to force collection —
perturbing the timings rather than merely omitting a statistic. The guard lives in the child process
that measures, and every child is spawned with `--expose-gc`, so it fires only when a child is
invoked by hand without the flag.

### One process per benchmark

The runner measures nothing itself. It spawns a fresh child process per selected benchmark, one
at a time, and concatenates the children's reports into the single JSON document it prints.

Sharing one process makes a benchmark's numbers depend on what ran before it — heap shape, JIT
state, and accumulated GC pressure all carry over. Measured in one process, `post_churn_throughput` reads
around 240 µs; measured first in its own process, around 9 µs. Isolation is what makes one
benchmark's number comparable to another's.

The cost is roughly 150–300 ms of startup per child. Progress goes to stderr, the report to stdout,
and the first child failure aborts the run.

### Choosing an engine

```bash
npm run bench:once -- --engine bun
```

ecstatic targets browsers (V8) and Capacitor, which runs on JavaScriptCore (JSC), so the runner
takes `--engine node|bun`, defaulting to `node`. Bun is the JSC proxy: it needs a separate install
([bun.sh](https://bun.sh)), and `--engine bun` reports `bun not found` if it is missing.

Treat Bun numbers as indicative rather than exact for the Capacitor target. Bun embeds JSC, but
WKWebView's JSC differs in version, JIT tiering policy, and memory limits. The pairing is sound for
tracking regressions on the JSC side; it is not a measurement of the shipping runtime.

## Methodology

**Fixed N.** Every benchmark runs at `DEFAULT_N = 1000`. There are no entity-count sweeps.

**Two timing shapes.** Net-neutral bodies — reads, overwrites, or a despawn/respawn pair that
restores the population — build one world during setup and reuse it across every sample, which lets
mitata batch for its best resolution. World-consuming bodies run under mitata's manual-timing mode:
the world is rebuilt before each iteration and destroyed after, both outside the clock. This differs
from the Lua suite, which rebuilt the world every iteration everywhere; for net-neutral bodies the
distinction is immaterial, since each sample sees the same population and field ranges.

**Consuming benchmarks report no heap.** Their per-iteration world construction would dominate any
heap delta, so `heap` is disabled for them and only `/time` metrics are emitted.

**Benchmarks are comparable to each other.** Each one is the first thing its process does, so a
figure carries no residue from whatever ran before it. Reading `many.spawn_empty` against
`entity.spawn_empty`, or the `soa_*` family against itself, is what the suite is built for.

**Numbers are not comparable to the Lua suite.** Same workloads and same archetype shapes, different
runtime. Compare a ported benchmark against another ported benchmark, or against itself across
commits — never against the Lua figure for the same name.

**Determinism.** Entity shuffles draw from a seeded generator (`random.ts`), so a given world layout
is identical on every run.

## Coverage

27 of the original suite's 95 timed benchmarks are ported. The rest are blocked on API that this port
does not have yet; the phase column names the port-roadmap phase that introduces it — phase 4 is
bitmasks and filters, phase 5 is resources and relations.

**Ported** means the benchmark runs the same operations in the same order and volumes as its Lua
original. **Adapted** means it does the same work, but reaching it required a deliberate departure
from the original — a different API surface, or a step the host language makes necessary. Each
adapted row says which.

### access — 5 of 5

| Benchmark    | Status  | Note                                                          |
| ------------ | ------- | ------------------------------------------------------------- |
| `get_1field` | Ported  |                                                               |
| `get_2field` | Adapted | Two single-field `get` calls — no multi-field `get` overload  |
| `get_4field` | Adapted | Four single-field `get` calls — same reason                   |
| `set_1field` | Ported  |                                                               |
| `set_record` | Adapted | `set(storage, id, Position, {…})` — no multi-component record |

### entity — 6 of 9

| Benchmark              | Status  | Blocked on                     | Phase |
| ---------------------- | ------- | ------------------------------ | ----- |
| `spawn_empty`          | Ported  |                                |       |
| `spawn_with_data`      | Ported  |                                |       |
| `spawn_indirect`       | Ported  |                                |       |
| `despawn`              | Ported  |                                |       |
| `spawn_recycle`        | Ported  |                                |       |
| `alive_check`          | Ported  |                                |       |
| `spawn_with_queries`   | Skipped | `each` filters                 | 4     |
| `despawn_with_queries` | Skipped | `each` filters, `enableMany`   | 4     |
| `spawn_with_optionals` | Skipped | spawn-with-optionals overrides | 4     |

### iteration — 9 of 21

| Benchmark                | Status  | Blocked on                                                                                  | Phase |
| ------------------------ | ------- | ------------------------------------------------------------------------------------------- | ----- |
| `throughput`             | Ported  |                                                                                             |       |
| `post_churn_throughput`  | Ported  |                                                                                             |       |
| `each_chained`           | Ported  |                                                                                             |       |
| `each_with_despawn`      | Ported  |                                                                                             |       |
| `soa_1field`             | Ported  |                                                                                             |       |
| `soa_2field`             | Ported  |                                                                                             |       |
| `soa_5field`             | Ported  |                                                                                             |       |
| `soa_10field`            | Ported  |                                                                                             |       |
| `deferred_despawn`       | Adapted | Buffer truncated for real; the Lua original relied on nil-truncation, a no-op on a JS array |       |
| `each_multi_arch`        | Skipped | multi-storage `each`                                                                        | 4     |
| `each_many_with_despawn` | Skipped | multi-storage `each`                                                                        | 4     |
| `each_many_filtered`     | Skipped | multi-storage `each`, filters, `enable`                                                     | 4     |
| `frame_churn`            | Skipped | `each` filters, to prime the filtered pass its setup depends on                             | 4     |
| `system_loop`            | Skipped | `each` filters, `enable`/`disable`                                                          | 4     |
| `system_loop_each_many`  | Skipped | multi-storage `each`, `enable`/`disable`                                                    | 4     |
| `multi_system_frame`     | Skipped | `each` filters, `enableMany`/`disableMany`                                                  | 4     |
| `query_partial_1of20`    | Skipped | `query`                                                                                     | 4     |
| `query_20pass`           | Skipped | `query`                                                                                     | 4     |
| `query_no_match`         | Skipped | `query`                                                                                     | 4     |
| `system_loop_query`      | Skipped | `query`, `has`, `enable`/`disable`                                                          | 4     |
| `multi_arch_frame`       | Skipped | `query`, filters, `enableMany`/`disableMany`                                                | 4     |

### many — 7 of 15

| Benchmark           | Status  | Blocked on    | Phase |
| ------------------- | ------- | ------------- | ----- |
| `spawn_empty`       | Ported  |               |       |
| `spawn_with_data`   | Ported  |               |       |
| `spawn_out_reuse`   | Ported  |               |       |
| `despawn`           | Ported  |               |       |
| `despawn_half`      | Ported  |               |       |
| `despawn_all`       | Ported  |               |       |
| `despawn_world`     | Ported  |               |       |
| `enable`            | Skipped | `enableMany`  | 4     |
| `enable_multi`      | Skipped | `enableMany`  | 4     |
| `enable_all`        | Skipped | `enableMany`  | 4     |
| `enable_data`       | Skipped | `enableMany`  | 4     |
| `enable_data_multi` | Skipped | `enableMany`  | 4     |
| `enable_data_all`   | Skipped | `enableMany`  | 4     |
| `disable`           | Skipped | `disableMany` | 4     |
| `disable_all`       | Skipped | `disableMany` | 4     |

### Suites not ported at all

| Suite      | Count | Benchmark names                                                                                                                                                                                                                                                                                                          | Blocked on                         | Phase |
| ---------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------- | ----- |
| `tag`      | 11    | `has`, `has_any`, `has_multi`, `has_any_multi`, `enable`, `disable`, `disable_multi`, `enable_data`, `enable_data_defaults`, `enable_with_queries`, `disable_with_queries`                                                                                                                                               | `has`/`hasAny`, `enable`/`disable` | 4     |
| `filter`   | 6     | `each_all`, `each_all_none`, `each_any`, `query_all_none`, `query_dispatch_only`, `query_resolve_per_arch`                                                                                                                                                                                                               | `each` filters, `query`            | 4     |
| `query`    | 5     | `cache_cold`, `across_1arch`, `across_5arch`, `across_10arch`, `across_20arch`                                                                                                                                                                                                                                           | `query`                            | 4     |
| `resource` | 5     | `get`, `set`, `set_indirect`, `reset`, `reset_nonscalar`                                                                                                                                                                                                                                                                 | resources                          | 5     |
| `relation` | 18    | `link`, `link_with_data`, `link_reassign`, `unlink`, `get_target`, `spawn_with_relation`, `despawn_source`, `despawn_target`, `query_sources`, `query_sources_filtered`, `nested_query_sources`, `get_sources`, `has_sources`, `count_sources`, `retarget_fan_in`, `unlink_fan_in`, `cascade_fan_in`, `nested_transform` | relations                          | 5     |

`query()` has no phase entry of its own in the roadmap, so every benchmark blocked on it is counted
against phase 4, alongside the cross-archetype filter work.

### Outside the 95

| Suite        | Count | Status  | Note                                                                                                                                                                                                   |
| ------------ | ----- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `alloc_gate` | 30    | Skipped | A separate memory-comparison harness, not timed benchmarks. Nine of its 30 bodies fit the current API, but its shared setup needs `enable`, `query`, resources, and relations, so it is skipped whole. |

## Layout

| File            | Contents                                                                |
| --------------- | ----------------------------------------------------------------------- |
| `main.ts`       | Entry point: spawns one child per benchmark, or measures one as a child |
| `runner.ts`     | Argument parsing, benchmark registry, report parsing and merging        |
| `helpers.ts`    | World builders, shared constants, manual-timing shim                    |
| `archetypes.ts` | Component and archetype definitions                                     |
| `random.ts`     | Seeded generator and Fisher-Yates shuffle                               |
| `*-bench.ts`    | One file per benchmark group                                            |
