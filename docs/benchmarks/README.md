# Benchmark specifications

Index for the documentation of ecstatic's entity component system (ECS) benchmark suite. Each
specification file below covers one benchmark group, with one section per benchmark documenting its
setup, measured operation, and the code path it targets for regression detection. For design
rationale and omission justifications, see [rationale](rationale.md). Constants and the component
palette shared by every group are in [parameters](specifications/parameters.md).

Run the suite with `npm run bench:once`; pass a pattern to run a subset, for example
`npm run bench:once -- '^iteration\.'`. The runner requires an exposed garbage collector and can
measure under a second engine; [`benchmarks/README.md`](../../benchmarks/README.md) covers both,
along with the comparison workflow for checking one revision against another.

## Benchmark groups

Benchmark names are `<prefix><benchmark>`, so the prefix column doubles as the filter to run just
that group.

| Group     | Prefix       | Specification                               | Source                                                                 |
| --------- | ------------ | ------------------------------------------- | ---------------------------------------------------------------------- |
| Entity    | `entity.`    | [entity.md](specifications/entity.md)       | [`benchmarks/entity-bench.ts`](../../benchmarks/entity-bench.ts)       |
| Access    | `access.`    | [access.md](specifications/access.md)       | [`benchmarks/access-bench.ts`](../../benchmarks/access-bench.ts)       |
| Iteration | `iteration.` | [iteration.md](specifications/iteration.md) | [`benchmarks/iteration-bench.ts`](../../benchmarks/iteration-bench.ts) |
| Batch     | `many.`      | [batch.md](specifications/batch.md)         | [`benchmarks/many-bench.ts`](../../benchmarks/many-bench.ts)           |
