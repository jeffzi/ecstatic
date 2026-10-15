# Benchmarks

Regression-detection benchmarks for ecstatic, timed with
[mitata](https://github.com/evanwashere/mitata). The
[reference group](../docs/benchmarks/specifications/reference.md) holds hand-fused twins of two
iteration benchmarks, `throughput` and `frame`. Each twin runs the column loop a compile-time
transform would emit for its `each()` call, which sets a speed ceiling for that benchmark. The
reference group is not a regression target.

For what each benchmark measures and why, see [`docs/benchmarks/`](../docs/benchmarks/README.md).
This file covers running the suite, choosing an engine, and passing the allocation gate.

## Running

The runner is `npx tsx --expose-gc benchmarks/main.ts`. It prints one JSON report covering every
selected benchmark, and takes an optional pattern to measure a subset and `--engine` to pick the
engine:

```bash
npm run -s build
npx tsx --expose-gc benchmarks/main.ts '^iteration/'              # one group, node only
npx tsx --expose-gc benchmarks/main.ts --engine node,bun 'soa'     # both engines
npx tsx --expose-gc benchmarks/main.ts --engine bun                # bun only
```

`--engine` accepts a comma-separated list of engines; the default is `node`. Aliases in the report
are always prefixed with the engine (`node/access/get_1field`, `bun/access/get_1field`). The filter
matches the plain benchmark name (without the engine prefix), so `'^iteration/'` selects the
iteration group under every requested engine.

Bare `"ecstatic"` imports resolve through the package's own `exports` map to `dist/`, so both the
suite and the allocation gate measure the last compiled output; build before running the suite by
hand.

Set `BENCH_GENERATION=<n>` to measure worlds whose tracked entity ids sit at generation `n`: the
world builder recycles the tracked slots until every tracked id is at that generation and leaves
`DEFAULT_N` free slots on the freelist, so benchmarks that spawn draw recycled slots too. Background
entities stay at generation 1. Unset, every id is at generation 1 and the freelist is empty. The
accepted range is 1 to 1023: a slot has 1,023 generations, so a larger value would wrap and measure
a lower generation than the one asked for. A value that is not an integer in that range is a usage
error.

The pattern is an unanchored regular expression matched against benchmark names. A pattern that
matches nothing is an error, not an empty report. A pattern cannot begin with `-`, which would parse
as a flag.

The suite requires an exposed garbage collector and exits non-zero without one, because mitata would
otherwise substitute a fallback that allocates a 1 GiB buffer per benchmark to force collection —
perturbing the timings rather than merely omitting a statistic. The guard lives in the child process
that measures, and every child is spawned with `--expose-gc`, so it fires only when a child is
invoked by hand without the flag.

### One process per benchmark

The runner measures nothing itself. It spawns a fresh child process per selected benchmark, one at a
time, and concatenates the children's reports into the single JSON document it prints.

Sharing one process makes a benchmark's numbers depend on what ran before it — heap shape, JIT
state, and accumulated GC pressure all carry over. Measured in one process, `post_churn_throughput`
reads around 240 µs; measured first in its own process, around 9 µs. Isolation is what makes one
benchmark's number comparable to another's.

The cost is roughly 150–300 ms of startup per child. The runner prints nothing but the report on
success; the first child failure aborts the run with the child's diagnostics on stderr.

### Choosing an engine

ecstatic targets browsers (V8) and Capacitor, which runs on JavaScriptCore (JSC), so the runner
takes `--engine node|bun` (or `--engine node,bun` for both), defaulting to `node`. Bun is the JSC
proxy: it needs a separate install ([bun.sh](https://bun.sh)), and a missing `bun` aborts the run
with `bun not found`.

Treat Bun numbers as indicative rather than exact for the Capacitor target. Bun embeds JSC, but
WKWebView's JSC differs in version, JIT tiering policy, and memory limits. The pairing is sound for
tracking regressions on the JSC side; it is not a measurement of the shipping runtime.

## Allocation gate

The timing suite reports time only. Memory is owned by `alloc/gate.ts`, a pass/fail script that
`npm run check:alloc` runs (and `npm run check` includes):

```bash
npm run check:alloc
```

For every gated operation the gate builds a warm world in its own child process — setup runs the
operation 200 times so capacity growth, archetype-cache fills, and V8 tier-up allocations happen
before measurement — then repeatedly forces a collection, reads `process.memoryUsage().heapUsed`,
runs the operation over `DEFAULT_N` entities, reads again, and reports the median delta per entity
as bytes/op. Every body is steady-state (spawn then despawn, enable then disable, link then unlink,
set back to the same value), so rounds do not drift.

`alloc/budgets.ts` holds the budget table (`ALLOC_BUDGETS`, bytes/op) and the tolerance
(`EPSILON_BYTES`). The comparison is two-sided: an operation over its budget is a regression, and
one measurably under its budget is slack — the gate fails on both, and the fix for slack is to lower
the budget in the same commit. Budgets ratchet down only; never raise one to silence a failure. The
gate needs `--expose-gc` and refuses to run without it.
