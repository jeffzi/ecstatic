# Benchmarks

Regression-detection benchmarks for ecstatic, timed with
[mitata](https://github.com/evanwashere/mitata).

For what each benchmark measures and why, see [`docs/benchmarks/`](../docs/benchmarks/README.md).
This file covers running the suite and how much of the original Lua suite it currently covers.

## Running

Two npm scripts drive the suite, and a third runs the allocation gate. Both bench scripts need
[gymrat setup](#gymrat-setup); the gate needs nothing beyond this repository.

- `npm run bench:autoresearch` runs a supervised gymrat optimization session: gymrat launches the
  agent with [`gymrat-runbook.md`](gymrat-runbook.md), builds, samples, verdicts, and logs; the
  session ends at the runbook's stop condition or the wall-clock cap. The script sets
  `--max-minutes 480` (doubled for the two-engine suite); a trailing flag overrides it
  (`npm run bench:autoresearch -- --max-minutes 30`, the last occurrence wins).
- `npm run bench:measure` measures the working tree in place with gymrat's `measure`, using a
  build-only prepare step so the configured `npm ci` never touches your checkout. It reports a
  median ± spread per metric with no deltas and no verdicts — see
  [Reading the noise floor](#reading-the-noise-floor). Extra flags pass through
  (`npm run bench:measure -- --samples 15`).
- `npm run check:alloc` runs the [allocation gate](#allocation-gate): builds, then measures bytes
  per operation of the hot API against the budget table in `alloc/budgets.ts`. It is part of
  `npm run check`, so a gymrat `keep` refuses an iteration that allocates over budget.

Bare `"ecstatic"` imports resolve through the package's own `exports` map to `dist/`, so both the
suite and the gate measure the last compiled output; every gymrat path builds first.

The underlying runner is `npx tsx --expose-gc benchmarks/main.ts` — the command `gymrat.toml`
drives. `gymrat.toml` runs both engines (`--engine node,bun`), so `gymrat iterate` measures and
gates 54 `/time` metrics; a `keep` gates on both engines. Run the runner by hand to measure a subset
or a single engine; it prints one JSON report covering every selected benchmark:

```bash
npm run -s build
npx tsx --expose-gc benchmarks/main.ts '^iteration/'              # one group, node only
npx tsx --expose-gc benchmarks/main.ts --engine node,bun 'soa'     # both engines
npx tsx --expose-gc benchmarks/main.ts --engine bun                # bun only
```

`--engine` accepts a comma-separated list of engines; the default is `node`. Aliases in the report
are always prefixed with the engine (`node/access/get_1field`, `bun/access/get_1field`), and gymrat
metric names carry the same prefix (`node/access/get_1field#time`). The filter matches the plain
benchmark name (without the engine prefix), so `'^iteration/'` selects the iteration group under
every requested engine.

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

## gymrat setup

[gymrat](https://github.com/jeffzi/gymrat-py) provides both `npm run bench:autoresearch` and
`npm run bench:measure`. It is a Python tool installed outside this repository, so nothing in
`package.json` refers to it:

```bash
uv tool install gymrat-py   # or: uv tool install <gymrat-py-checkout>
gymrat doctor               # verifies the config, skill file, runbook, and bench command
```

`gymrat.toml` in the repository root supplies the bench command, the prepare command, the mitata
adapter, the sample count, the checks a `keep` must pass, the stop condition, and the runbook path.

### Reading the noise floor

`npm run bench:measure` samples one unchanged target, so the spread column reports dispersion that
no code change can explain: the machine's noise floor. With both engines configured, the run reports
54 metrics (27 benchmarks × 2 engines) and takes about twice as long as a single-engine run. A noise
floor is per engine — read the `node/` and `bun/` rows separately. Raise `--samples` when a verdict
gates anything:

```bash
npm run bench:measure -- --samples 15
```

A benchmark whose spread here is wider than the delta an iteration reports has not shown you a
change. Some benchmarks are near-zero-variance — `node/many/despawn_all` self-compared within a
±0.9% band at `--samples 5` — and at low sample counts a gate can read that band as a real change.

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

## Known limitations

gymrat is pre-1.0; these rough edges are accepted until it matures.

- **The install is machine-local.** Without `gymrat` on `PATH`, neither `npm run bench:autoresearch`
  nor `npm run bench:measure` works — CI and fresh clones are in that position. A worktree is
  unaffected: its prepare runs plain `npm ci`, and a worktree never invokes gymrat itself. Windows
  is untested; both commands run locally on macOS.
- **A hand-run in-place `gymrat measure` or `gymrat compare` without `--prepare` runs `npm ci`
  against your working tree.** `npm run bench:measure` overrides the prepare step with a bare build;
  when calling gymrat directly, pass `--prepare "npm run -s build"` to skip the reinstall.
