# ecstatic benchmark runbook

Domain rules for gymrat optimization sessions in this repository. gymrat owns the loop; this file
says what to optimize, what to leave alone, and what must happen before an edit.

**Violating the letter of these rules is violating their spirit.** There are no technicalities.

## Objective

Reduce nanoseconds per operation across the timing suite — the geometric mean of every
`<engine>/<group>/<name>#time` metric on both V8 (node) and JavaScriptCore (JSC, bun) — subject to
no per-metric regression on either engine. A V8 win that regresses any JSC metric is refused by
`keep`, and the agent must not chase the geomean alone. Correctness, the public API, and the test
suite are preserved.

## How the loop runs

`gymrat supervise` starts a supervised session; `gymrat start` runs the same loop by hand. gymrat
owns everything mechanical: it builds through the `prepare` step in `gymrat.toml`, samples the
suite, draws progress, prints verdicts, records the log, and runs `npm test`, then `npm run check`,
before a `keep` lands. This runbook adds only the domain rules.

Edit in the experiment worktree that `start` printed, then `gymrat iterate`, then `gymrat keep -m`
or `gymrat discard`. Every mutating gymrat command holds a per-repository lock, so run one thing at
a time; a second gymrat process exits 2.

**Before your first edit of each iteration, state in one line** which operation you are targeting,
whether the change is a single-function micro-optimization (profiling gate applies) or a
cross-cutting refactor (full `iterate` decides), and which measurement justifies it. An iteration
without that line is a guess.

**Waiting is the whole job while `iterate` runs.** One pass over the suite takes about four minutes
on a laptop (both engines). `iterate` builds both worktrees and runs `samples` (6) passes over each
— twelve passes — and a regression verdict adds a confirmation rerun of the whole suite, so expect
an `iterate` to take forty to eighty minutes. Launch it, then wait for the completion notification
and nothing else: no polling the process, no tailing its output, no other commands. Every poll
spends context for zero information. Launch a benchmark command only when none is running. A bun
install is required for the session; a missing bun aborts `iterate`.

## Benchmark suite

31 benchmarks in 5 groups: `access` (5), `entity` (6), `iteration` (11), `many` (7), `reference`
(2), each measured under both engines — 31 × 2 = 62 gating `#time` metrics. Aliases carry an
`<engine>/` prefix (`node/access/get_1field`, `bun/access/get_1field`), and all benchmarks run under
node before bun. Memory is the allocation gate's job (node only). No `filter` is configured, so all
62 gate a `keep`; the primary metric is the geomean of all of them (gymrat's default).

`benchmarks/main.ts` measures nothing itself. It spawns one child process per benchmark, one at a
time, so heap shape, JIT state, and GC pressure from one benchmark never reach the next. Measured in
a shared process, `iteration/post_churn_throughput` reads around 240 µs; alone, around 9 µs. Every
number the session records depends on that isolation, so every optimization lives in `src/` and the
runner stays as it is.

Bare `"ecstatic"` imports resolve through the package's `exports` map to `dist/`, so the suite
measures compiled output. gymrat builds before every measurement; a hand-run suite needs
`npm run build` first.

## Allocation gate

`npm run check:alloc` (part of `npm run check`, so `keep` enforces it) measures bytes allocated per
operation for 28 hot operations — iteration, access, tags, spawn/despawn, resources, relations —
each on a warm world in its own child process, and compares the median against `ALLOC_BUDGETS` in
`benchmarks/alloc/budgets.ts`. A budget of `0` means the operation must not allocate at all; the
eight nonzero budgets pin allocations that were measured when the budget was written, with a comment
naming the cause where it is known. Those nonzero budgets are the allocation backlog.

The budget is two-sided and only ratchets down:

- **Over** (median above budget + `EPSILON_BYTES`) is a regression. Fix the code.
- **Slack** (median below budget − `EPSILON_BYTES`) is an improvement you MUST claim: lower the
  budget to the new measured value in the same commit as the change. This is the one edit under
  `benchmarks/` an optimization commit may contain.

Budgets are harness-specific: they hold for the gate's warm-up and round counts
(`benchmarks/alloc/gate.ts`) and the entity count (`DEFAULT_N` in `benchmarks/helpers.ts`).

**No exceptions:**

- A budget never goes up. Not "temporarily", not "to unblock the keep", not with a comment.
- `EPSILON_BYTES`, `WARMUP_ROUNDS`, `ROUNDS`, and `DEFAULT_N` are not tuning knobs. Changing any of
  them re-pins every nonzero budget and is not an optimization commit.
- An op is never removed from `ALLOC_BUDGETS` or `benchmarks/alloc/ops.ts` to make the gate pass.

When adding an operation to `benchmarks/alloc/ops.ts`, keep it steady-state: a mutating body must
leave the world unchanged across rounds (spawn then despawn, enable then disable, link then unlink,
set back to the same value), so no round measures a world the previous round grew.

## Profiling gate

**This is a hard gate, not a suggestion.** Before micro-optimizing a single hot function — rewriting
the body of `spawn`, `despawn`, `enable`, `disable`, `get`, `set`, `has`, `link`, an `each`/`query`
callback loop, or any other function one benchmark measures per entity — you MUST have profiler
output from an isolated script that names the expensive lines of _that_ function. Cross-cutting
refactors that change data layout or control flow across many functions are evaluated by the full
`iterate`, not by this gate.

**No exceptions:**

- "It follows the same pattern as X" is not profiling data — cost distribution differs per function.
- "The change is small" does not skip the gate; small changes to hot functions are exactly what
  regresses.
- A timing loop you wrote yourself is not a sanctioned tool, whether it lives in a script, a test,
  or a REPL.

Use only these tools — the suite's driver already does calibration, GC control, and timing:

**V8 (node):**

- `node --cpu-prof script.js` writes a `.cpuprofile`; open it in Chrome DevTools (Performance panel,
  "Load profile") or [speedscope](https://www.speedscope.app) for line-level self time.
- `node --prof script.js && node --prof-process isolate-*.log` prints a tick summary by function —
  quicker than the CPU profile when you only need to rank functions.
- `node --trace-opt --trace-deopt script.js` shows optimization and deoptimization events; a
  function that deoptimizes in a loop is the first thing to fix.
- `node --allow-natives-syntax script.js` with `%DebugPrint(obj)` in the script prints an object's
  hidden class and element kind — the check for "do all entities/records share one shape?". Node's
  V8 no longer ships `--trace-ic`; use `--trace-deopt` (megamorphic sites surface as deopt reasons)
  and `%DebugPrint` instead.

**JSC (bun):**

- `bun --cpu-prof script.js` writes a `.cpuprofile` for Chrome DevTools or speedscope;
  `bun --cpu-prof-md script.js` prints a grep-friendly summary to stdout.
- There is no `--trace-deopt` equivalent. JSC micro-optimizations are justified by `--cpu-prof`
  self-time plus a tinybench A/B under `bun`.

**Both engines:**

- tinybench for A/B comparison of candidate implementations in one script, the library
  `benchmarks/measure.ts` drives.
- Optional, not dependencies: `0x` or `clinic flame` for flame graphs (node only). Neither goes into
  `package.json`.

Workflow:

1. Write a standalone script under `benchmarks/tmp/` (gitignored — profiling scripts are never
   committed) that imports from `dist/` (`import … from "ecstatic"` after `npm run build`), so it
   measures what ships. Isolate the hot operation with the same entity count and archetype layout as
   the benchmark that measures it (`benchmarks/archetypes.ts`, `benchmarks/helpers.ts`).
2. Put every candidate implementation in the same script so they run under identical conditions.
3. Profile with `--cpu-prof` or `--prof` to find the costly lines; check `--trace-deopt` output for
   deopt loops.
4. Compare candidates with tinybench and pick the winner.
5. Only then edit `src/`, and run the full `gymrat iterate` — the pipeline is the final gate.

## At floor — do not optimize

None recorded yet. When an operation reaches the point where profiling shows only memory latency or
architectural overhead, add it here with the engine the floor was proven on and the measurement that
proves it (the profile or the tinybench comparison and its numbers), so later sessions do not
re-mine it.

## Off limits

Every optimization is an edit under `src/`. These stay untouched for the whole session:

- Existing tests under `tests/` — they define correctness; an optimization that needs an existing
  test edited, skipped, or deleted is a behavior change. Adding new test files or cases is allowed
  (and expected when an optimization reshapes internals); they must pass like every other test.
- `benchmarks/` — the harness, benches, helpers, and docs define the measurement. Two exceptions:
  lowering a budget in `benchmarks/alloc/budgets.ts` when the gate reports slack, and adding a
  finding to this runbook's "At floor" section.
- `package.json`, `tsconfig*.json`, `scripts/`, `vitest.config.ts`, `lefthook.yml`, `cspell.json`,
  `.oxlintrc.json` and the other lint configs — build and check configuration. Editing them can
  silence a failing gate.
- The public API — everything exported from `src/ecstatic/index.ts`: names, signatures, observable
  semantics. Internals may change freely.

## Non-negotiables

- `npm test` passes; no existing test is edited, skipped, or weakened.
- No new dependencies.
- Behavior is preserved; only speed changes.
- No gating metric regresses (`iterate` reports it; `keep` refuses it).
- No edit to an off-limits file beyond the two exceptions above.
- The profiling gate is honored before a single-function micro-optimization.
- The allocation gate is honored: no over-budget op, no unclaimed slack.

## Engine constraints

A change must hold on both V8 and JSC. Bun is the JSC proxy: WKWebView's JSC differs in version and
JIT tiering policy, so relative deltas transfer but absolute numbers do not.

**V8 (node):**

- **Keep call sites monomorphic.** Every entity record, storage object, and archetype descriptor
  that flows through a hot function should have one hidden class. Build objects with the same
  property order every time; never add properties after construction on hot-path objects.
- **Keep hot property accesses monomorphic.** A property read that sees more than four shapes goes
  megamorphic and stops being inlined. When a helper is called with many shapes, split it or
  specialize it per caller rather than accepting the polymorphism.
- **Pass explicit parameters in hot functions.** `arguments`, rest parameters, and spread allocate
  and defeat inlining.
- **Match the suite's storage kinds.** Where the suite already uses typed arrays, keep typed arrays;
  where it uses plain arrays, keep them packed (no holes, no mixed element kinds — writing a double
  into an integer-only array transitions the whole array).

**JSC (bun):**

- JSC's DFG (Data Flow Graph) and FTL (Faster Than Light) just-in-time (JIT) tiers optimize
  monomorphic shapes similarly to V8, so the V8 monomorphic call-site rules apply here too.
- JSC's inlining budget is smaller than V8's TurboFan. Functions that are borderline-inlined under
  V8 may not inline under JSC; splitting large hot functions helps both engines.

**Both engines:**

- **`--expose-gc` is required by the harness.** Both the timing suite and the allocation gate refuse
  to run without it, so every profiling script that reuses them needs the flag too.
- **Read the noise floor first.** `gymrat measure` on an unchanged tree reports the median ± spread
  per metric with no deltas; a delta smaller than that spread is not a result. A single-sample
  improvement is not a result either.

## Rationalizations

| Excuse                                            | Reality                                                                                                                     |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| "I'll check on the benchmark while I wait"        | The notification arrives on its own. Polling only burns context.                                                            |
| "X was sped up this way, so Y will be too"        | Different function, different cost lines. Profile Y.                                                                        |
| "Too small a change to profile"                   | Small edits to hot functions are the usual regression. Gate applies.                                                        |
| "A quick `performance.now()` loop is enough"      | Hand-rolled loops measure wrong. The suite's own driver (`benchmarks/measure.ts`, tinybench) or the profiler, nothing else. |
| "I'll bump the budget now and fix it next round"  | Budgets only go down. Fix the allocation or discard.                                                                        |
| "The test is wrong now that the internals moved"  | Then the behavior moved. Discard the change; add a test instead of editing one.                                             |
| "One helper in `benchmarks/` won't skew anything" | The harness is off limits; the helper belongs in `src/` or `benchmarks/tmp/`.                                               |
| "The delta is 2%, that's a win"                   | Read `gymrat measure` spread first. Under the spread it is noise, not a keep.                                               |
| "It only regressed on bun"                        | Bun gates. Discard or fix the JSC regression before keeping.                                                                |
| "Iterations are slow, I'll stop early"            | Iterate until `iterate` names the stop condition. Stopping early wastes the run.                                            |

## Red flags — stop and re-read the gate you are about to skip

- You are about to run a command while an `iterate` is in flight.
- You are editing `src/` for a per-entity function and have no profile output for it.
- Your diff touches `tests/` (an existing test), `benchmarks/` (outside the two exceptions), or a
  config file.
- A budget in `benchmarks/alloc/budgets.ts` went up, or `EPSILON_BYTES`/`WARMUP_ROUNDS` changed.
- You are writing a `for` loop with `performance.now()` around it.
- You are calling a run "improved" without having looked at the noise floor.

## Quick reference

| Action                   | Command                                |
| ------------------------ | -------------------------------------- |
| Start a session          | `gymrat start`                         |
| Supervised session       | `gymrat supervise`                     |
| Measure + verdict        | `gymrat iterate`                       |
| Keep iteration           | `gymrat keep -m "describe the change"` |
| Discard iteration        | `gymrat discard`                       |
| Session status           | `gymrat status`                        |
| Finalize                 | `gymrat finalize -m "squash message"`  |
| Working-tree noise floor | `gymrat measure`                       |
| Allocation gate only     | `npm run check:alloc`                  |
| What `keep` runs         | `npm test`, then `npm run check`       |
| Tests only               | `npm test`                             |
| Build only               | `npm run build`                        |
