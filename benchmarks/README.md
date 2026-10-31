# Benchmarks

Regression-detection benchmarks for ecstatic, timed with
[tinybench](https://github.com/tinylibs/tinybench). The
[reference group](../docs/benchmarks/specifications/reference.md) holds hand-inlined twins of two
iteration benchmarks, `throughput` and `frame`. Each twin runs the column loop a build-time
optimizer would emit for its `each()` call, which sets a speed ceiling for that benchmark. The
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

Each figure in the report is the median sample divided by the calls that sample ran.
`performance.now()` advances in steps of about 41.7 ns under both engines on the Apple M2 Max where
the suite was measured. Warmup sizes every benchmark's count, net-neutral or world-consuming, so a
sample spans at least 200 timer steps, and every timed sample runs that count. A net-neutral
benchmark leaves the world as it found it, so it times its calls back to back on one world. A
world-consuming benchmark times its calls one fresh world at a time: each world is built before its
call and destroyed after it, outside the clock, and the sample's span is the sum of its calls'
spans.

A batched reading is the median over samples of each sample's span divided by its count. That
average takes in the slow calls a single call's median leaves out, so a benchmark whose count is
above 1 reads higher than the median of one call: about 7.5 % for `many/despawn_all` on Bun, a body
near 1.1 µs. A change in count therefore moves a benchmark's reading even when the body's cost is
unchanged. [Timing lifecycle](../docs/benchmarks/rationale.md#conventions) explains why each kind is
timed the way it is.

Bare `"ecstatic"` imports resolve through the package's own `exports` map to `dist/`, so both the
suite and the allocation gate measure the last compiled output; build before running the suite by
hand.

### Optimized run

`--optimized` measures the suite as the build-time optimizer compiles it:

```bash
npm run -s build
npx tsx --expose-gc benchmarks/main.ts --optimized '^iteration/'
npx tsx --expose-gc benchmarks/main.ts --optimized --engine node,bun
```

Before measuring anything, the runner opens the benchmark project (`benchmarks/tsconfig.json`) in
the TypeScript compiler, rewrites every benchmark source through the optimizer in strict mode, and
emits the JavaScript into `.bench-optimized/` (gitignored), each file at its path from the
repository root. It compiles once per run, then spawns every child from the compiled
`benchmarks/main.js` under each requested engine, with no TypeScript loader. The aliases carry an
`optimized/` segment after the engine (`node/optimized/iteration/throughput`), so a plain report and
an optimized report merge without colliding. The filter still matches the plain benchmark name.

The output directory sits inside the package and outside `node_modules`, so the compiled
`import "ecstatic"` and `import "ecstatic/internal"` resolve to `dist/` through the package's
`exports`, as the plain suite's imports do; build first. The compile also writes the `src/` and
`scripts/` modules the benchmarks import there; only the `scripts/` copies are loaded.

Strict mode means a benchmark site the optimizer cannot rewrite fails the compile, rather than
quietly timing the runtime call. A TypeScript error, an optimizer diagnostic, or an output file that
cannot be written fails the compile; the run then exits 1 before measuring anything, with the cause
on stderr and nothing on stdout.

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

The suite requires an exposed garbage collector and exits non-zero without one. The driver collects
garbage once, after warmup and before the first timed sample, so no collection left over from setup
or warmup lands inside a timed sample. The guard lives in the child process that measures. The
runner spawns every child with `--expose-gc`, so the guard fires only when someone runs a child by
hand without the flag.

### One process per benchmark

The runner measures nothing itself. It spawns a fresh child process per selected benchmark, one at a
time, and concatenates the children's reports into the single JSON document it prints.

Sharing one process makes a benchmark's numbers depend on what ran before it — heap shape, JIT
state, and accumulated GC pressure all carry over. Measured in one process, `post_churn_throughput`
reads around 240 µs; measured first in its own process, around 9 µs. Isolation is what makes one
benchmark's number comparable to another's.

Before it measures, a child loads only the driver and the suite of the benchmark it measures, and
none of the code that spawns children. On Bun, code loaded in the process slows a reading even when
none of it runs: with every suite and the spawning code loaded, `many/despawn_all` read about 3–4 %
and `many/despawn` about 1 % slower. The entry's own code still leaves those two about 1.5 % and 0.2
% slower than alone in a module of their own, as the
[`despawn_all`](../docs/benchmarks/specifications/batch.md#despawn_all) and
[`despawn`](../docs/benchmarks/specifications/batch.md#despawn) specifications record.

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
