# Benchmark specifications

Index for the documentation of ecstatic's entity component system (ECS) benchmark suite. Each
specification file below covers one benchmark group, with one section per benchmark documenting its
setup, measured operation, and the code path it targets for regression detection. For design
rationale and omission justifications, see [rationale](rationale.md). Constants and the component
palette shared by every group are in [parameters](specifications/parameters.md).

Run the suite with `npx tsx --expose-gc benchmarks/main.ts` after a build; pass a pattern to run a
subset, for example `npx tsx --expose-gc benchmarks/main.ts '^iteration/'`. The runner requires an
exposed garbage collector and can measure under a second engine;
[`benchmarks/README.md`](../../benchmarks/README.md) covers both, along with the measurement and
optimization workflows.

## Benchmark groups

Benchmark names are `<prefix><benchmark>`, so the prefix column doubles as the filter to run just
that group. The runner prefixes every reported name with the engine (`node/`, `bun/`), so the full
reported name is `<engine>/<prefix><benchmark>`. The filter matches the plain name (without the
engine prefix).

| Group     | Prefix       | Specification                               | Source                                                                 |
| --------- | ------------ | ------------------------------------------- | ---------------------------------------------------------------------- |
| Entity    | `entity/`    | [entity.md](specifications/entity.md)       | [`benchmarks/entity-bench.ts`](../../benchmarks/entity-bench.ts)       |
| Access    | `access/`    | [access.md](specifications/access.md)       | [`benchmarks/access-bench.ts`](../../benchmarks/access-bench.ts)       |
| Iteration | `iteration/` | [iteration.md](specifications/iteration.md) | [`benchmarks/iteration-bench.ts`](../../benchmarks/iteration-bench.ts) |
| Batch     | `many/`      | [batch.md](specifications/batch.md)         | [`benchmarks/many-bench.ts`](../../benchmarks/many-bench.ts)           |
| Reference | `reference/` | [reference.md](specifications/reference.md) | [`benchmarks/reference-bench.ts`](../../benchmarks/reference-bench.ts) |
