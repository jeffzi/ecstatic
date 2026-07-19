# Archetype ECS — Internal Architecture Reference

## Overview

ecstatic is an archetype-based Entity Component System with Structure-of-Arrays (SoA) layout.
Each archetype defines a fixed set of **required components** (always present) and
**optional components** (toggled at runtime via bitmask). Component data is stored in
parallel columns — one per field — rather than per-entity, enabling cache-friendly iteration
and zero per-entity allocation overhead.

Key concepts:

- Dense entity storage per archetype (rows in a sparse set)
- Swap-and-pop deletion ensures rows stay densely packed
- Generational entity IDs with always-on aliasing checks
- 32-bit bitmask for optional component presence
- Per-row matched flags to avoid mask checks during hot iteration

## Data Structures

### Archetype

An archetype is both a type definition and a sparse set. It stores entities, their component
data, and query state.

```text
Archetype
├── sparse: number[]                    // sparse index → dense index
├── entities: Float64Array              // dense index → entity ID (53-bit safe integer)
├── n: number                           // current entity count
├── mask: Uint32Array                   // dense index → optional component bitmask
├── columns: Map<Descriptor, Column>    // descriptor → SoA column
├── requiredColumns: Column[]           // required component SoA (hot path)
├── components: Descriptor[]            // required component descriptors
├── queries: QueryState[]               // registered query states
└── meta: ArchMeta                      // cold metadata lookup
    ├── optionals: Descriptor[]         // optional component descriptors
    ├── descriptorByName: Map<string, Descriptor>
    └── bitByDescriptor: Map<Descriptor, number> // descriptor → bit (0..31)
```

**Parallel arrays**: `entities`, `mask`, and every column are indexed in parallel. Index `i`
refers to the same entity across all of them. There is no dense→sparse array: the sparse
index of row `i` is recovered arithmetically as `entities[i] % 2^24`.

| row [i]  | 0 (sparse 3) | 1 (sparse 0) | 2 (sparse 7) |
| -------- | ------------ | ------------ | ------------ |
| entities | id₃          | id₀          | id₇          |
| mask     | 0b011        | 0b000        | 0b001        |
| Pos.x    | 10.0         | 5.0          | 0.0          |
| Pos.y    | 20.0         | 15.0         | 0.0          |
| Vel.dx   | 1.0          | -1.0         | 0.5          |

The sparse map `sparse[3] = 0`, `sparse[0] = 1`, `sparse[7] = 2` translates entity sparse
indices to dense row positions.

### SoA Columns

Each component defines one column record with one array per field:

```typescript
interface Column {
  [field: string]: TypedArray | unknown[]
}
// e.g. Position → { x: Float64Array, y: Float64Array }
```

**Numeric fields** store in TypedArray columns (default `Float64Array`; width markers like
`i16()` opt into `Int16Array`, `u8()` into `Uint8Array`, etc.). This enables dense,
cache-friendly memory layout and predictable allocation.

**Ref fields** and **strings** store in plain JS arrays (`unknown[]`). They are wrapped in
the type system: a `ref<T>()` field unwraps to `T | undefined`.

Columns are indexed through the archetype's canonical `columns` map and aliased directly on
the archetype for ergonomic access (e.g., `arch.Position` points to `columns.get(Position)`).

### Optional Component Bitmask

Each optional component is assigned a bit position (0–31) at archetype creation:

| Optional | Bit value | Bit position |
| -------- | --------- | ------------ |
| Stunned  | 1         | 0            |
| OnFire   | 2         | 1            |
| Shielded | 4         | 2            |

The `mask[i]` array stores the bitmask for each dense row. For example, `mask[i] = 5`
(0b101) means Stunned and Shielded are enabled; OnFire is disabled.

Since JavaScript supports native 32-bit bitwise operations, up to 32 optional components
per archetype are supported without lookup tables.

### Query State

Each unique `(allMask, anyMask, noneMask)` triple creates a `QueryState`:

```typescript
interface QueryState {
  allMask: number;      // bits that MUST ALL be set
  anyMask: number;      // bits where AT LEAST ONE must be set
  noneMask: number;     // bits that must NOT be set
  matched: boolean[];   // parallel to the dense rows: true if row matches
}
```

**Match computation**: A row at index `i` matches if:

- `(mask[i] & allMask) === allMask` (all required bits set)
- `anyMask === 0 || (mask[i] & anyMask) !== 0` (at least one optional bit set, or no
  constraint)
- `(mask[i] & noneMask) === 0` (no forbidden bits set)

The `matched[i]` boolean is maintained incrementally on spawn, enable, and disable, so
iteration never recomputes masks — it only reads the precomputed boolean.

### Generational Entity IDs

Entity IDs pack a **24-bit sparse index** and a **29-bit generation** into a single safe
integer, using arithmetic packing (not bitwise, which truncates to 32 bits in JavaScript):

```text
id = generation * (2^24) + index
   = generation * 16777216 + index
```

The world's `generation` array stores the current occupant's **full packed ID** at each
index, so the hot-path operations are single reads and comparisons:

**Packing**: on spawn, `id = generation[index]` — a plain read; the slot's next ID is
precomputed

**Unpacking**: `index = id % 2^24`; the ID is live iff `generation[index] === id`

**Fresh slot init**: `generation[index] = 2^24 + index` (generation 1)

**Generation advance** (on despawn): `generation[index] += 2^24`, wrapping back to
generation 1 (`2^24 + index`) when the generation would reach 2^29.

**Limits**:

- Max index: 2^24 = 16,777,216 entities (usable: 0..16,777,215)
- Generations per index: 2^29 − 1 = 536,870,911 cycles before repeat

Fresh indices start at generation 1 (generation 0 is a "never allocated" sentinel). When an
index is recycled, its generation advances, preventing stale IDs from colliding with live
ones.

Every public entity operation validates that the entity ID's generation matches the current
generation at that index. These checks compile out under a build-time `NDEBUG` define.

**Exception**: `despawn` of a stale ID is a defined no-op, always. This pattern is common
in deferred cleanup and multi-system teardown where IDs may outlive their entities.

### Component Descriptors

```typescript
interface ComponentDescriptor {
  name: string;                    // e.g., "Position"
  fields: string[];                // sorted field names: ["x", "y"]
  defaults: Record<string, unknown> // { x: 0, y: 0 }
}
```

Components are declared via `component(name, fields?)` or grouped via
`components({ Name: defaults })`. Zero-field components (boolean flags) use the same
descriptor structure with `fields: []` and `defaults: {}`, but do not allocate SoA columns
unless used as data-carrying optionals.

### World State

```typescript
interface WorldState {
  archetypes: Archetype[];                // all registered archetypes
  entityArch: (Archetype | undefined)[]  // sparse entity index → archetype
  generation: Float64Array                // full packed ID of the current occupant per index
  sparse: Int32Array                      // index → dense row; dead slots hold the freelist next pointer
  freeHead: number                        // LIFO freelist head (−1 = empty)
  nextIndex: number                       // next fresh sparse index
  queryCache: Map<string, Archetype[]>   // component-set key → cached archetypes
  resources: Map<number, object>          // resource ID → data
}
```

Users see an opaque `World` type. Internally, operations cast `World` to `WorldState`.

## Operations

### spawn

Allocates a new entity in the archetype.

```text
spawn(storage, overrides?)
  1. Allocate sparse index (from freelist or fresh)
  2. Read entity ID: id = generation[index] (the slot's packed ID is precomputed)
  3. Append dense row
  4. Write entity ID and initialize all columns from defaults or overrides
  5. Initialize mask from overrides (optionals may be enabled at spawn; otherwise 0)
  6. Compute matched flags for the initial mask in all query states
  7. Record arch in entityArch[index]
  8. Return id
```

### despawn

Removes an entity using swap-and-pop deletion.

```text
despawn(world, id)
  1. Unpack: index = id % 2^24
  2. Validate: generation[index] === id (stale ID → no-op)
  3. Resolve archetype and dense row index
  4. If not the last row, swap-and-pop:
     - Copy last row into the hole (entities, all columns, mask, matched)
     - Update sparse mapping for the swapped entity (its sparse index = entities[hole] % 2^24)
  5. Decrement archetype.n
  6. Free the sparse index:
     - generation[index] += 2^24 (wrap to generation 1 when the generation would reach 2^29)
     - Push index onto freelist
     - Clear entityArch[index]
```

**Why reverse iteration is safe**: Swap-and-pop fills the deletion hole with the last row.
When iteration runs backward (n−1 to 0), the swapped-in row was already visited; despawning
during iteration skips no unvisited entities.

### enable / disable

Toggles optional components on a live entity.

```text
enable(storage, id, component, values?)
  1. Resolve entity to archetype and dense row
  2. Resolve bit position for the optional component
  3. Set bit: mask[row] |= bit
  4. If component has fields and values provided: write to SoA columns
  5. Recalculate matched flags for all queries
```

```text
disable(storage, id, component)
  1. Resolve entity to archetype and dense row
  2. Resolve bit position
  3. Clear bit: mask[row] &= ~bit
  4. Recalculate matched flags for all queries
```

`enable` and `disable` are pure bit flips at the mask level. SoA fields are not zeroed;
disabling hides them (filtered out by `matched[]`). Re-enabling resumes the prior data,
enabling resume semantics without deallocating.

### despawnMany

Bulk-removes all entities in an archetype without an explicit ID list.

```text
despawnMany(storage)
  1. For each dense row i in 0..n−1, with index = entities[i] % 2^24:
     - Advance generation[index]
     - Push index onto freelist
     - Clear entityArch[index]
  2. Set archetype.n = 0
  3. Do NOT zero SoA columns (stale data is inaccessible)
```

The ids form, `despawnMany(storage, ids)`, despawns only the live IDs in the list — stale
IDs are skipped, consistent with `despawn`'s stale-ID no-op.

### each

Iterates entities in one or more archetypes, optionally filtered.

```text
each(storage, [filter], fn) or each([storages], [filter], fn)
  1. For each archetype in the list:
     2. If filter provided, register or resolve query state
     3. Iterate from n−1 down to 0:
        - If filter: skip row unless matched[i] is true
        - Rebind the reused per-archetype view to row i
        - Call fn(view)
```

The view is a reused object per archetype with generated accessors over the columns — no
per-entity allocation, and property access stays monomorphic. Each archetype keeps one view
per nesting depth, so nested `each` over the same archetype rebinds distinct views (a
pairwise pass reads two different rows through two views). The build-time transform may
replace an `each` call with a fused direct-column loop, but the design never depends on it:
the untransformed path is fully correct and is the performance floor.

Iteration runs **backward** (n−1 down to 0) so despawning the current entity during
iteration is safe: swap-and-pop only moves the last row (already visited) into the hole.

Spawning during iteration appends at the end — which backward iteration has already passed,
so new entities are deterministically not visited in the current pass.

Views are ephemeral: they are rebound per row and must not be stored. IDs are the durable
handle for anything outliving the callback.

### query

Iterates entities across multiple archetypes matching a filter.

```text
query(world, compsOrFilter, fn)
  1. Resolve filter to component bit masks or descriptor list
  2. Check world-level query cache:
     - If hit: use cached archetype list
     - If miss: scan all archetypes, build and cache the list
  3. For each matching archetype:
     4. Register or resolve query state
     5. Iterate via each(archetype, queryState, fn)
```

**Filter resolution**:

- For each required component: if optional, OR its bit into `allMask`; if required, check
  that the archetype has it (if not, archetype is impossible).
- For each any component: OR its bit into `anyMask`; if none match the archetype, the
  archetype is impossible.
- For each none component: OR its bit into `noneMask`.

The world-level query cache stores the list of matching archetypes by a canonical component
set key, so repeated calls with the same filter reuse the precomputed list.

## Key Design Decisions

### Dense SoA Layout

Component data is stored in parallel columns (one per field), not per-entity. Iterating
`Position.x[0..n]` scans contiguous memory — cache-friendly compared to AoS, where x, y,
and z values are interleaved.

Named aliases like `arch.Position` provide ergonomic typed access (`arch.Position.x[i]`)
without map lookup on every access.

### Reverse Iteration

`each` iterates from `n−1` down to 0. Combined with swap-and-pop deletion, this makes
despawning the current entity during iteration safe by construction: the swapped-in row
fills the hole behind the current iteration point, which has already been visited.

Similarly, spawning during a reverse pass appends new entities at the end, which the pass
has already passed, so new entities are deterministically skipped.

### Bitmask for Optionals

Optional components (adjectives, toggles) are tracked via a per-row 32-bit bitmask. Each
optional is assigned one bit; enabling and disabling are O(1) bit flips. This avoids
structural changes (moving entities between archetypes) and keeps the archetype static.

Native 32-bit bitwise operations support up to 32 optionals per archetype without lookup
tables or interpretation overhead.

### Incremental matched[] Maintenance

Rather than scanning all entities' masks on every query, the `matched[]` boolean array is
kept up-to-date incrementally:

- **spawn**: `matched[i]` is set based on the initial mask (0)
- **enable/disable**: `matched[i]` is recalculated for the new mask
- **despawn**: `matched[i]` is swapped from the last row

This means `each` reads one boolean per row — no mask computation in the hot loop.

### Generational IDs

Static archetypes with dense sparse sets allow immediate, safe entity removal. Generational
entity IDs provide temporal safety: a stale ID (old generation) never aliases with a live
entity, even after the sparse index has been recycled.

Checks are gated by an `NDEBUG` build flag. When enabled (default), every public entity
operation validates the generation. When disabled (production), checks compile out.

`despawn` of a stale ID is always a no-op, not gated — deferred cleanup patterns depend on
this.

### LIFO Freelist

Freed sparse indices are pushed onto a stack (freelist). Fresh allocations pop from the
head. LIFO reuse means recently freed indices (still warm in cache) are recycled first,
improving memory locality.

### World-Level Query Cache

`query(world, [Comp1, Comp2], fn)` must discover which registered archetypes contain all
requested components. Without caching, this requires scanning all archetypes on every call.

The world maintains a `queryCache: Map<string, Archetype[]>` mapping a canonical
component-set key to the list of matching archetypes. On first call, the cache is populated
by scanning; subsequent calls reuse the precomputed list.

Keys are built from sorted component names, so the same set always produces the same key
regardless of query order.
