# Archetype ECS: internal architecture reference

## Contents

- [Overview](#overview)
- [Data structures](#data-structures)
  - [Storage](#storage)
  - [SoA columns](#soa-columns)
  - [Optional component bitmask](#optional-component-bitmask)
  - [Matchers](#matchers)
  - [Generational entity IDs](#generational-entity-ids)
  - [Component descriptors](#component-descriptors)
  - [World state](#world-state)
- [Operations](#operations)
  - [spawn](#spawn)
  - [despawn](#despawn)
  - [enable / disable](#enable--disable)
  - [despawnMany](#despawnmany)
  - [each](#each)
  - [query](#query)
- [Key design decisions](#key-design-decisions)
  - [Dense SoA layout](#dense-soa-layout)
  - [Reverse iteration](#reverse-iteration)
  - [Bitmask for optionals](#bitmask-for-optionals)
  - [Incremental matched-flag maintenance](#incremental-matched-flag-maintenance)
  - [Generational IDs](#generational-ids)
  - [LIFO freelist](#lifo-freelist)
  - [Query cache](#query-cache)

## Overview

ecstatic is an archetype-based Entity Component System (ECS) with Structure-of-Arrays (SoA) layout.
Each archetype defines a fixed set of **required components** (always present) and **optional
components** (toggled at runtime via bitmask). Component data is stored in parallel columns — one
per field — rather than per-entity, enabling cache-friendly iteration and zero per-entity allocation
overhead.

Key concepts:

- Dense entity storage per archetype (rows in a sparse set)
- Swap-and-pop deletion ensures rows stay densely packed
- Generational entity IDs with always-on aliasing checks
- 32-bit bitmask for optional component presence
- Per-row matched flags to avoid mask checks during hot iteration

## Data structures

### Storage

An archetype is a type definition. Registering it in a world creates its `Storage`: the sparse set
that holds the archetype's entities, their component data, and matcher state.

```text
Storage
├── id: number                            // same as the archetype's id
├── world: WorldState                     // owning world
├── archetype: ArchetypeDescriptor        // registered archetype (components, optionals)
├── entities: Float64Array                // dense index → entity ID (30-bit packed integer)
├── n: number                             // current entity count
├── mask: Uint32Array                     // dense index → optional component bitmask
├── matchers: Matcher[]                   // registered matchers, deduped by (all, any, none)
├── matcherMatched: Uint8Array[]          // matcherMatched[i] is matchers[i].matched
├── columns: Map<Descriptor, SoAColumns>  // descriptor → SoA column record
├── flatColumns: Column[]                 // every column, flat (swap-and-pop loops)
├── fieldColumns: Map<Descriptor, FieldColumn[]> // per-field handles that views read
├── generation, sparse                    // aliases of the world's arrays
├── despawnClear, hasDespawnClear         // ref columns cleared on despawn (GC release)
├── hasOptionalData: boolean              // some optional carries data fields
├── relationTargetColumns, relationDescriptors, relationOptionalBits, relationN
├── hasRelations: boolean                 // archetype carries any relation
├── componentByName: Map<string, Descriptor>
├── componentLookup: Set<Descriptor>
├── optionalBitLookup: Map<Descriptor, number>    // optional descriptor → bit (0..31)
└── optionalNotBitLookup: Map<Descriptor, number> // optional descriptor → inverted bit
```

**Parallel arrays**: `entities`, `mask`, and every column are indexed in parallel. Index `i` refers
to the same entity across all of them. There is no dense→sparse array: the sparse index of row `i`
is recovered arithmetically as `entities[i] % 2^20`.

| row [i]  | 0 (sparse 3) | 1 (sparse 0) | 2 (sparse 7) |
| -------- | ------------ | ------------ | ------------ |
| entities | id₃          | id₀          | id₇          |
| mask     | 0b011        | 0b000        | 0b001        |
| Pos.x    | 10.0         | 5.0          | 0.0          |
| Pos.y    | 20.0         | 15.0         | 0.0          |
| Vel.dx   | 1.0          | -1.0         | 0.5          |

The sparse map `sparse[3] = 0`, `sparse[0] = 1`, `sparse[7] = 2` translates entity sparse indices to
dense row positions.

### SoA columns

Each component defines one column record with one array per field:

```typescript
interface Column {
  [field: string]: TypedArray | unknown[];
}
// e.g. Position → { x: Float64Array, y: Float64Array }
```

**Numeric fields** store in TypedArray columns (default `Float64Array`; width markers like `i16()`
opt into `Int16Array`, `u8()` into `Uint8Array`, etc.). This enables dense, cache-friendly memory
layout and predictable allocation.

**Ref fields** and **strings** store in plain JS arrays (`unknown[]`). They are wrapped in the type
system: a `ref<T>()` field unwraps to `T | undefined`.

Columns are indexed through the storage's canonical `columns` map and aliased directly on the
storage for ergonomic access (e.g., `storage.Position` points to `columns.get(Position)`).

### Optional component bitmask

Each optional component is assigned a bit position (0–31) at archetype creation:

| Optional | Bit value | Bit position |
| -------- | --------- | ------------ |
| Stunned  | 1         | 0            |
| OnFire   | 2         | 1            |
| Shielded | 4         | 2            |

The `mask[i]` array stores the bitmask for each dense row. For example, `mask[i] = 5` (0b101) means
Stunned and Shielded are enabled; OnFire is disabled.

Since JavaScript supports native 32-bit bitwise operations, up to 32 optional components per
archetype are supported without lookup tables.

### Matchers

Each unique `(allMask, anyMask, noneMask)` triple registers one `Matcher` on the storage:

```typescript
interface Matcher {
  allMask: number; // bits that MUST ALL be set
  anyMask: number; // bits where AT LEAST ONE must be set
  noneMask: number; // bits that must NOT be set
  filterMask: number; // union of the three: refreshes skip matchers the changed bits miss
  matched: Uint8Array; // parallel to the dense rows: 1 if the row matches
}
```

**Match computation**: A row at index `i` matches if:

- `(mask[i] & allMask) === allMask` (all required bits set)
- `anyMask === 0 || (mask[i] & anyMask) !== 0` (at least one optional bit set, or no constraint)
- `(mask[i] & noneMask) === 0` (no forbidden bits set)

The `matched[i]` flag (`Uint8Array`) is maintained incrementally on spawn, enable, and disable, so
iteration never recomputes masks — it only reads the precomputed flag.

### Generational entity IDs

Entity IDs pack a **20-bit sparse index** and a **10-bit generation** into a single 30-bit integer,
which stays inside the small-integer range that JavaScript engines store without allocating:

```text
id = generation * (2^20) + index
   = generation * 1048576 + index
```

The world's `generation` array stores the current occupant's **full packed ID** at each index, and
the slot's next ID while the slot is free, so the hot-path operations are single reads and
comparisons:

**Packing**: on spawn, `id = generation[index]` — a plain read; the slot's next ID is precomputed. A
free slot whose generation wrapped holds that ID negated, and spawn negates it back.

**Unpacking**: `index = id % 2^20`; the ID is live iff `generation[index] === id`. A free slot's
entry is an ID that has not been issued yet, or a negative number after a wrap, so no issued ID
matches a free slot.

**Fresh slot init**: `generation[index] = 2^20 + index` (generation 1)

**Generation advance** (on despawn): `generation[index] += 2^20`. When the generation would reach
2^10 it wraps back to generation 1, and despawn stores that ID negated (`-(2^20 + index)`): it was
issued before, and a negative entry keeps the old ID from matching the free slot.

**Limits**:

- Max index: 2^20 = 1,048,576 entities (usable: 0..1,048,575)
- Generations per index: 2^10 − 1 = 1,023 cycles before repeat

Fresh indices start at generation 1 (generation 0 is a "never allocated" sentinel). When an index is
recycled, its generation advances, so a stale ID fails the comparison until the generation repeats.

**The bound on stale detection**: a dead ID matches a live entity again once its slot has been
recycled (despawned, then respawned) 1,023 times since the ID was issued. Reuse is last-freed-first,
so a slot that is despawned and respawned every frame gets there in about 17 seconds at 60 frames
per second. Code that checks `alive()` on a held ID every frame sees the death and never reaches the
repeat. The exposed case is an ID held unchecked for longer than that: a delayed callback, a save
file, a late network message.

Every public entity operation validates that the entity ID's generation matches the current
generation at that index. These checks compile out when a bundler defines `NDEBUG`, or switch off
when `globalThis.NDEBUG` is set before ecstatic is first imported.

**Exception**: `despawn` of a stale ID is a defined no-op, always. This pattern is common in
deferred cleanup and multi-system teardown where IDs may outlive their entities.

#### Why an ID is 30 bits wide

V8 stores a number inline only inside its small-integer range: 31 bits on Node, and 30 bits on
builds with pointer compression such as Chrome. Any other number is a 16-byte heap object, allocated
each time an ID crosses a call the engine did not inline.

With 24 index bits an ID left that range at generation 128 (64 on Chrome), so a slot recycled once
per frame started allocating on every spawn after about two seconds, for the rest of the world's
life. That broke the allocation pillar ([pillars.md](../pillars.md), pillar 9) on a warm world. The
allocation gate reads these bytes per spawn and despawn pair:

| Operation                                   | 24 index bits | 20 index bits |
| ------------------------------------------- | ------------- | ------------- |
| `spawn` and `despawn`                       | 48            | 0             |
| `spawnMany` and `despawnMany`               | 45            | 29            |
| The same with a caller-owned ID array       | 32            | 0             |
| `spawn` with a required relation, `despawn` | 134           | 86            |

Keeping every ID below 2^30 removes that allocation on every engine. JavaScriptCore never allocated
for a number, so nothing changes there.

**What it costs**: a world holds 1,048,576 entities, a sixteenth of what 24 index bits allowed, and
a slot has 1,023 generations where the wider ID had hundreds of millions.

**Why 20 and 10**: each bit moved from the index to the generation halves the entity ceiling and
doubles the generations. 20 index bits keep a one-million-entity world.

**Why reuse order did not change with it**: a reserve of free slots, or retiring a slot when its
generations run out, would lengthen the distance before an ID repeats, each at a cost on spawn or
despawn. Last-freed-first reuse is also the order the determinism pillar specifies
([pillars.md](../pillars.md), pillar 12).

### Component descriptors

```typescript
interface ComponentDescriptor {
  __ecstatic_name: string; // e.g., "Position"
  __ecstatic_fields: string[]; // sorted field names: ["x", "y"]
  __ecstatic_defaults: Record<string, unknown>; // { x: 0, y: 0 }
  __ecstatic_default_values: unknown[]; // defaults in field order
  __ecstatic_is_reference: (boolean | undefined)[]; // per field: plain-array ref column
  __ecstatic_component_key: string; // "<length>:<name>"
  __ecstatic_column_ctor?: (NumericColumnCtor | undefined)[]; // per field: TypedArray constructor
}
```

Components are declared via `component(name, fields?)` or grouped via
`components({ Name: defaults })`. Zero-field components (boolean flags) use the same descriptor
structure with `__ecstatic_fields: []` and `__ecstatic_defaults: {}`, but do not allocate SoA
columns unless used as data-carrying optionals.

### World state

```typescript
interface WorldState {
  storages: Map<number, Storage>; // archetype id → storage
  entityArch: (Storage | undefined)[]; // sparse entity index → storage
  generation: Float64Array; // occupant's full packed ID per index; next ID while free
  sparse: Int32Array; // index → dense row; dead slots hold the freelist next pointer
  freeHead: number; // LIFO freelist head (−1 = empty)
  nextIndex: number; // next fresh sparse index
  resources: Map<number, Record<string, unknown>>; // resource ID → data record
  relations: RelationDescriptor[]; // relations registered in this world
  hasAnyRelations: boolean; // true once any registered archetype carries a relation
  reverseMap: Map<ComponentDescriptor, RelationReverseMap>; // relation → reverse index
  maxTargetIndex: number; // highest target index with a reverse entry (−1 = none)
  queryEpoch: number; // bumped by register/destroyWorld; validates cached query resolutions
  destroyed?: true; // set by destroyWorld
}
```

Users see an opaque `World` type. Internally, operations cast `World` to `WorldState`.

## Operations

### spawn

Allocates a new entity in the archetype.

```text
spawn(storage, overrides?)
  1. Allocate sparse index (from freelist or fresh)
  2. Read entity ID: id = generation[index] (the slot's packed ID is precomputed; negated back
     first if the freed slot's generation had wrapped)
  3. Append dense row
  4. Write entity ID and initialize all columns from defaults or overrides
  5. Initialize mask from overrides (optionals may be enabled at spawn; otherwise 0)
  6. Compute matched flags for the initial mask in all matchers
  7. Record the storage in entityArch[index]
  8. Return id
```

### despawn

Removes an entity using swap-and-pop deletion.

```text
despawn(world, id)
  1. Unpack: index = id % 2^20
  2. Validate: generation[index] === id (stale ID → no-op)
  3. Resolve archetype and dense row index
  4. If not the last row, swap-and-pop:
     - Copy last row into the hole (entities, all columns, mask, matched)
     - Update sparse mapping for the swapped entity (its sparse index = entities[hole] % 2^20)
  5. Decrement storage.n
  6. Free the sparse index:
     - generation[index] += 2^20 (when the generation would reach 2^10: wrap to generation 1,
       stored negated so the ID issued before does not match the free slot)
     - Push index onto freelist
     - Clear entityArch[index]
```

**Why reverse iteration is safe**: Swap-and-pop fills the deletion hole with the last row. When
iteration runs backward (n−1 to 0), the swapped-in row was already visited; despawning during
iteration skips no unvisited entities.

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

`enable` and `disable` are pure bit flips at the mask level. SoA fields are not zeroed; disabling
hides them (filtered out by the `matched` flags). Re-enabling resumes the prior data, enabling
resume semantics without deallocating.

### despawnMany

Bulk-removes all entities in an archetype without an explicit ID list.

```text
despawnMany(storage)
  1. For each dense row i in 0..n−1, with index = entities[i] % 2^20:
     - Advance generation[index], as in despawn
     - Push index onto freelist
     - Clear entityArch[index]
  2. Set storage.n = 0
  3. Do NOT zero SoA columns (stale data is inaccessible)
```

The ids form, `despawnMany(storage, ids)`, despawns only the live IDs in the list — stale IDs are
skipped, consistent with `despawn`'s stale-ID no-op.

### each

Iterates entities in one or more archetypes, optionally filtered.

```text
each(storage, [filter], fn) or each([storages], [filter], fn)
  1. For each archetype in the list:
     2. If filter provided, register or resolve its matcher
     3. Iterate from n−1 down to 0:
        - If filter: skip row unless matched[i] is true
        - Rebind the reused per-archetype view to row i
        - Call fn(view)
```

The view is a reused object per archetype with generated accessors over the columns — no per-entity
allocation, and property access stays monomorphic. Each archetype keeps one view per nesting depth,
so nested `each` over the same archetype rebinds distinct views (a pairwise pass reads two different
rows through two views). A future build-time optimizer could replace an `each` call with an inlined
direct-column loop, but the design never depends on it: the unoptimized path is fully correct and is
the performance floor.

Iteration runs **backward** (n−1 down to 0) so despawning the current entity during iteration is
safe: swap-and-pop only moves the last row (already visited) into the hole.

Spawning during iteration appends at the end — which backward iteration has already passed, so new
entities are deterministically not visited in the current pass.

Views are ephemeral: they are rebound per row and must not be stored. IDs are the durable handle for
anything outliving the callback.

### query

Iterates entities across multiple archetypes matching a filter.

```text
query(world, compsOrFilter, fn)
  1. Normalize the filter into all/any/none component lists
  2. Check the query cache for this filter object and world:
     - If hit (epoch unchanged): use the cached storages and matchers
     - If miss: scan all storages, register a matcher on each match, cache the result
  3. For each matching storage:
     4. Iterate its rows with its matcher, as each does
```

**Filter resolution**:

- For each required component: if optional, OR its bit into `allMask`; if required, check that the
  archetype has it (if not, archetype is impossible).
- For each any component: OR its bit into `anyMask`; if none match the archetype, the archetype is
  impossible.
- For each none component: OR its bit into `noneMask`.

The query cache stores the matching storages per filter object (see [Query cache](#query-cache)), so
repeated calls with the same filter object reuse the resolution.

## Key design decisions

### Dense SoA layout

Component data is stored in parallel columns (one per field), not per-entity. Iterating
`Position.x[0..n]` scans contiguous memory — cache-friendly compared to Array-of-Structures (AoS),
where x, y, and z values are interleaved.

Named aliases like `storage.Position` provide ergonomic typed access (`storage.Position.x[i]`)
without map lookup on every access.

### Reverse iteration

`each` iterates from `n−1` down to 0. Combined with swap-and-pop deletion, this makes despawning the
current entity during iteration safe by construction: the swapped-in row fills the hole behind the
current iteration point, which has already been visited.

Similarly, spawning during a reverse pass appends new entities at the end, which the pass has
already passed, so new entities are deterministically skipped.

### Bitmask for optionals

Optional components (adjectives, toggles) are tracked via a per-row 32-bit bitmask. Each optional is
assigned one bit; enabling and disabling are O(1) bit flips. This avoids structural changes (moving
entities between archetypes) and keeps the archetype static.

Native 32-bit bitwise operations support up to 32 optionals per archetype without lookup tables or
interpretation overhead.

### Incremental matched-flag maintenance

Rather than scanning all entities' masks on every query, each matcher's `matched` flags
(`Uint8Array`) are kept up-to-date incrementally:

- **spawn**: `matched[i]` is set from the initial mask (0 unless spawn overrides enable optionals)
- **enable/disable**: `matched[i]` is recalculated for the new mask
- **despawn**: `matched[i]` is swapped from the last row

This means `each` reads one flag per row — no mask computation in the hot loop.

### Generational IDs

Static archetypes with dense sparse sets allow immediate, safe entity removal. Generational entity
IDs provide temporal safety by comparing generations: a stale ID (old generation) fails the check
after its sparse index has been recycled, up to the bound in [pillars.md](../pillars.md), pillar 5.

By default `NDEBUG` is undefined and every public entity operation validates the generation.
Defining `NDEBUG` (production) compiles the checks out.

`despawn` of a stale ID is always a no-op, not gated — deferred cleanup patterns depend on this.

### LIFO freelist

Despawn pushes freed sparse indices onto a last-in, first-out (LIFO) stack, the freelist. Fresh
allocations pop from the head. LIFO reuse means recently freed indices (still warm in cache) are
recycled first, improving memory locality.

### Query cache

`query(world, [Comp1, Comp2], fn)` must discover which registered archetypes contain all requested
components. Without caching, this requires scanning all storages on every call.

A module-level `WeakMap` keyed by the filter object's identity holds one resolution per world: the
matching storages and the matcher registered on each. An entry stays valid while `world.queryEpoch`
is unchanged; `register` and `destroyWorld` bump the epoch, and the next call re-resolves.

The key is the object, not its contents. Two equal but distinct literals miss the cache, so a filter
written inline re-resolves on every call; hoist it to a constant to reuse the resolution.
