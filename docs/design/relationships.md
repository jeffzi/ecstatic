# Relationship System Design

Status: design — committed core. A relation is a **component with a
reverse-indexed `target` field**. The `target` is written only through dedicated,
world-scoped `link` / `unlink` verbs (and at birth by `spawn`), and read with `get` /
`getTarget`. The component verbs `set` / `enable` / `disable` deliberately do **not**
touch a relation's target. Confining reverse-index maintenance to a small, auditable
set of functions is the correctness property this design is built around.

The full function set is in [Committed API surface](#committed-api-surface) below. For
design motivation, see the design pillars; for existing communication patterns (entity
links, flag + system), see `docs/events.md`. For internal architecture, see
`docs/design/archetype.md`.

## Key Concepts

- **Relation**: A component with a reserved `target` field (an `EntityId`) that ecstatic
  maintains a reverse index for.
- **Source**: An entity that declares a relation — the entity holding the `target` field.
- **Target**: The entity that a source points to — stored in the relation's `target`
  field.
- **Reverse index**: An internal data structure mapping `(relation, target)` → sources,
  maintained automatically on every mutation and despawn.
- **Reverse query**: Looking up which sources point at a given target via `querySources()`
  or `getSources()`.
- **Required vs optional**: Required relations must receive a target at spawn; optional
  relations may be linked later via `link()`. Both are detached via `unlink()` (optional
  only) or `despawn`.
- **Birth-link**: At spawn, both required and optional relations record their target in
  the reverse index. The presence bit means "linked" — `spawn` is a writer.
- **The four writers**: Exactly four operations mutate relation state: `spawn`
  (birth-link), `link`, `unlink`, and `despawn` cleanup. `enable`/`disable`/`set` reject
  relations at compile time and runtime.
- **Constraint**: A component list the target must have (enforced at compile time on
  writes). A currently-disabled optional still satisfies constraints (they check the
  archetype's component presence map, not enabled state).

## Committed API surface

Eight relation-specific names, plus relation-aware `despawnMany(world, ids)` and
`despawnMany(world)` overloads. Reads and reverse queries are world-scoped; `relation()`
declares; `link` / `unlink` mutate. The component verbs do their ordinary jobs and never
write a relation's `target`.

| Function                                        | Scope | Purpose                                              |
| ----------------------------------------------- | ----- | ---------------------------------------------------- |
| `relation(name, constraints?, defaults?)`       | —     | Declare a relation descriptor                        |
| `link(world, id, rel, target, values?)`         | world | Attach or retarget (state-agnostic); maintains index |
| `unlink(world, id, rel)`                        | world | Detach an optional relation; maintains index         |
| `getTarget(world, id, rel)`                     | world | Alive-checked forward read (`EntityId \| undefined`) |
| `querySources(world, rel, target, filter?, fn)` | world | Live, filtered, typed reverse iteration              |
| `getSources(world, rel, target, out?)`          | world | Reverse lookup as a list (`EntityId[]`)              |
| `hasSources(world, rel, target)`                | world | Existence peek; short-circuits on first source       |
| `countSources(world, rel, target)`              | world | Cardinality read — total sources linking to target   |

The component verbs do their normal jobs: `spawn` sets a required relation's target at
birth (and validates it), `despawn` removes a dying entity's reverse entries, and `set`
writes a relation's **non-target** data fields. `set` / `enable` / `disable` never write
the `target` — that is reserved to `link` / `unlink` / `spawn`, which confines
reverse-index maintenance to one small, auditable set of functions. Two new world-scoped
`despawnMany` overloads — `despawnMany(world, ids)` (compose with `getSources` for
cascade) and `despawnMany(world)` (clear the whole world) — extend batch despawn across
archetypes.

## The core idea: a relation is a reverse-indexed component

Plain entity-link components (a field holding an `EntityId`) cover forward traversal
(source → target) with zero infrastructure. The gap is the reverse query: "which
entities point at this one?" Without an index, the answer is a full scan or hand-maintained
back-references.

A relation is a component with a reserved `target` field and a runtime-maintained reverse
index. It stores and reads like a component (`spawn`, `get`, `set`); the only
relation-specific operations are `link` / `unlink`, which maintain the reverse map.

### When to use which

| You need…                                    | Use                                                  | Cost                                         |
| -------------------------------------------- | ---------------------------------------------------- | -------------------------------------------- |
| Forward traversal only (source → its target) | **plain entity-link component** + `alive()`          | none beyond a field read                     |
| Reverse queries (target → its sources)       | **`relation()`** + `querySources()` / `getSources()` | reverse-map maintenance per mutation/despawn |

Promote a link to a relation **only if you actually reverse-query it.** The reverse map
is maintained on every mutation whether or not you query it, so a relation is strictly
more per-operation work than a plain field. Forward-only links stay plain components.

## Semantics

The link runs from a **source** entity to a **target** entity, reusing existing ECS
machinery (descriptors, SoA columns, the bitmask for optionals). On every axis its
semantics follow the component model:

- **One target per source** (one-to-one). The `target` SoA column is a flat `number[i]`,
  so it costs zero allocation. One-to-many is deferred; model it for now as a reverse
  one-to-one queried with `querySources()`, or as scalar-column links.
- **Required vs optional**, the same axis as components:
  - **Required** (first tuple slot): target set at spawn, always present. The target must
    be alive, checked at runtime on spawn; its component _shape_ is enforced separately
    at compile time by the relation's constraint. Retargeted with `link`; removed only
    by despawn (`unlink` is rejected).
  - **Optional** (second tuple slot): attached/detached at runtime via `link()` /
    `unlink()`, gated by the archetype bitmask exactly like an optional component — and
    drawing from the same 32-bit bitmask budget that tags and optional components share.
- **Target constraints**: a relation declares which components the target must have. The
  type system enforces this at **every write site** — the `spawn` override and `link`'s
  `target` parameter. An empty constraint allows any entity (pure identity references —
  ownership, attribution-with-reaction).
- **No hierarchies.** No depth tracking, no `propagate()`, no cycle detection.

ecstatic ships **no automatic reaction** to a target's death — no cascade despawn, no
auto-unlink as a gameplay event. It keeps the reverse index consistent and lets you react
explicitly via the cascade recipe. See [Target despawn behavior](#target-despawn-behavior).

## Schema

### `relation(name, constraints?, defaults?)`

Define a one-to-one relation. Returns a branded relation descriptor — assignable to a
`Component`, so it slots into archetype tuples unchanged. The second argument is
**discriminated by shape**: a **constraint array** (`[Position]`) or a **defaults object**
(`{ offsetX: 0 }`).

```typescript
const Owner = relation("Owner"); // pure link, any entity
const Targets = relation("Targets", [Position]); // target must have Position
const LastHitBy = relation("LastHitBy", { damage: 0 }); // unconstrained + data
const ChildOf = relation("ChildOf", [Position], { offsetX: 0 }); // constrained + data
```

`target` is reserved. Declaring a user data field named `target` is a compile error (and
a runtime error in the fallback). Argument 2 is discriminated by type: an array literal
matches constraints; an object literal matches defaults; `{}` and `[]` differ, so there
is no ambiguity.

### Archetype declaration

Relations are declared in archetype tuples — required or optional, same as components:

```typescript
const Missile = archetype(
  [Position, Velocity, Targets], // Targets required — always has one
  [],
);

const Turret = archetype(
  [Position, ChildOf], // ChildOf required — always has a parent
  [],
);
```

Relation data (like `ChildOf.offsetX`) becomes SoA columns on the archetype — accessible
as `arch.ChildOf.offsetX[i]`, identical to component fields. The reserved `target` is a
column too: `arch.ChildOf.target[i]`.

## Lifecycle API

### Why dedicated verbs over verb-reuse

An earlier proposal folded linking into `set` / `enable` / `disable`. Rejected: it spreads
reverse-index maintenance across every mutation verb, and leaks two runtime-only rules
(`enable` must carry `{ target }`; `set`-ing a target on a disabled optional is an error)
that the type system cannot enforce.

Relation targets are written only through the four writers: `spawn` (birth-link), `link`,
`unlink`, and despawn cleanup. `set` / `enable` / `disable` reject relations at both
compile time (type error) and runtime (dynamic fallback errors), so they structurally
cannot desync the index. `link`'s `target` is a required parameter (compile-time guarantee
of a live target) and is state-agnostic (attach and retarget are the same call).

### Spawn with a relation (birth-link)

The target is provided via the reserved `target` field in overrides. At spawn, ecstatic
records the target in the reverse index — the presence bit means "linked":

```typescript
const m = spawn(missiles, {
  Targets: { target: enemyId },
  Position: { x: 0, y: 0 },
});

// data-carrying relation: target + field overrides
const t = spawn(turrets, {
  ChildOf: { target: vehicleId, offsetX: 10, offsetY: -5 },
});
```

Required relations **must** receive a target at spawn — omitting the relation key is a
compile error, and a stale target errors before the entity is created. Optional relations
may provide a target at spawn (birth-link) or link later via `link()` — both paths record
the target in the reverse index. Boolean spawn form (`Rel: true`) is invalid for relations;
the target object form is always required.

The target's shape is guaranteed at compile time by the relation's constraint — see
[write-site constraints](#write-site-constraint-enforcement).

### Linking and retargeting — `link`

`link` attaches a source to a target and maintains the reverse map. It is **state-agnostic**:
the same call establishes a first link or retargets an existing one — internally it removes
the source from any previous target's bucket before inserting it into the new one. For an
optional relation it also sets the bitmask bit; for a required relation the bit is implicit.

```typescript
// attach / retarget a missile's required relation
link(world, missileId, Targets, enemyId);
link(world, missileId, Targets, newEnemyId); // same verb retargets

// retarget plus data fields, in one call
link(world, turretId, ChildOf, newVehicleId, { offsetX: 4 });

// attach an optional relation (pick up)
link(world, swordId, ContainedIn, bagId);
```

`target` is a **required parameter**, so there is no resume form to misuse: you cannot
re-link to a previous (possibly dead) target by omitting it. The target is validated alive
at the call; a stale source or target errors under `!NDEBUG`. Its component shape
is checked at compile time by the relation's constraint (see
[write-site constraints](#write-site-constraint-enforcement)).

A relation's **non-target data field** is written with ordinary `set`
(`set(turrets, turretId, ChildOf.offsetX, 4)`) — that path never touches the reverse map.
The `target` field itself is read-only through `get` / `getTarget` and writable only
through `link` / `spawn`; writing it via `set` is rejected (a compile error for typed call
sites, a runtime error in the dynamic fallback).

### Unlinking — `unlink`

`unlink` detaches an optional relation: it removes the source from its target's bucket,
clears the target column, and clears the bitmask bit.

```typescript
unlink(world, swordId, ContainedIn); // drop
```

`unlink` on a **required** relation is a runtime error (required-vs-optional is an
archetype-_position_ property, indistinguishable at the type level), consistent with
`disable` on a required component. A required relation's target is reassigned via `link`
and only removed by `despawn`.

### Reading a target — `get` and `getTarget`

Two reads, differing only in the liveness check:

```typescript
// get: returns the raw stored EntityId — no liveness check
const v = get(turrets, turretId, ChildOf.target); // EntityId
if (alive(world, v)) {
  /* live */
}

// getTarget: returns undefined if the relation is unlinked OR the target is dead
const enemy = getTarget(world, missileId, Targets); // EntityId | undefined
```

`get(storage, id, Rel.target)` is the relation equivalent of reading a plain entity-link
field — fast, unchecked, you call `alive()` yourself. `getTarget` adds the bitmask +
generation check and never hands back a dead target. Keep `getTarget` for the common
forward read where temporal safety matters; reach for `get` when you have already proven
the target live in the same frame.

The "no check" in `get` refers only to _target_ liveness. On an **optional** relation
that is currently unlinked, `get(storage, id, Rel.target)` still follows the standard
optional-component gate — it errors under `!NDEBUG`, exactly like reading any
disabled optional field.

## Reverse queries

Find the sources pointing at a given target, across every archetype that declares the
relation.

### `querySources(world, rel, target, filter?, fn)` — live, filtered, typed

Iterate every source whose `rel` currently points at `target`. The callback mirrors
`query()` — because the reverse map spans every source archetype that declares the
relation, the callback view is a cross-archetype union, not a single concrete archetype:

```typescript
// every missile currently targeting `enemyId`
querySources(world, Targets, enemyId, (e) => {
  // retarget, detonate, draw a lock-on icon…
});
```

Internally `querySources` first generation-checks `target`. A stale id — one whose slot
has since been recycled by a later entity — visits nothing rather than aliasing onto the
new occupant's bucket. For a live target it is a reverse-map lookup followed by an O(S)
walk over the S sources that actually point at the target — not a scan of all sources.

The bucket iteration is safe under despawn/retarget mutations of the current source:

- **Safe:** Despawning the current source, retargeting it (`link` to a different target),
  or despawning the target itself mid-callback. A retarget's insert lands in a _different_
  target's bucket, never the one being walked.
- **Unsafe:** `link`-ing a new source onto the walked target mid-callback (inserts a key
  into the bucket being iterated). Mutating other sources in the same bucket is also unsafe.

The conservative guidance: mutate only the **current** source inside `querySources`
callbacks.

An optional **filter** narrows the result by component, exactly like `each` / `query`
filters (`all` / `any` / `none`, or a bare array for `all`):

```typescript
// missiles targeting this enemy that are NOT stunned
querySources(world, Targets, enemyId, { none: [Stunned] }, (e) => {
  // …
});
```

With no filter, `querySources` allocates nothing even in the pure-runtime path. With a
filter, the descriptor is elided by the transform the same way `each` / `query` filter
descriptors are.

### `getSources(world, rel, target, out?)` — the source list

When you want sources as a **list** — to count them, hold them, mutate the set while
iterating, or hand them to `despawnMany` — `getSources` returns an `EntityId[]` instead
of calling back.

```typescript
function getSources(world: World, rel: Relation, target: EntityId, out?: EntityId[]): EntityId[];
```

- **`out` omitted** → allocates a fresh, owned array. Convenient default; safe to hold
  across frames.
- **`out` provided** → fills `out` and returns it. Zero allocation. The buffer is named
  at the call site, so the only reuse hazard is reusing your own visible buffer — ordinary
  manual buffer management, not hidden global state.
- The result is always a clean array of exactly the live sources: in the `out` path the
  leftover tail is cleared, so `result.length === n` holds whether the array was allocated
  or reused. Index it 0-based like any returned `EntityId[]` (`for…of`, or `0 … length -
1`).
- A stale or dead `target` (generation-checked) yields an empty result, matching
  `querySources` visiting nothing.

```typescript
getSources(world, MemberOf, teamRed).length; // count, directly

// a snapshot lets you mutate the whole set freely — retarget or despawn ANY source,
// not just the current one. Inside a querySources callback only the current source
// may be mutated; touching other sources in the live bucket corrupts the walk.
for (const m of getSources(world, MemberOf, teamRed)) {
  link(world, m, MemberOf, teamBlue);
}

// zero-alloc with a reused buffer
const filled = getSources(world, ContainedIn, bag, scratch);
for (let i = 0; i < filled.length; i++) {
  /* filled[i] */
}
```

`getSources` returns **bare IDs** — no bitmask context, no typed storage. Filtered or
typed per-source work stays with `querySources`. The two are complementary:

|                | Answers                                                     | Shape                         |
| -------------- | ----------------------------------------------------------- | ----------------------------- |
| `querySources` | "do work per live source, filtered/typed"                   | callback, zero-alloc, O(S)    |
| `getSources`   | "hand me the source list to hold, count, or mutate against" | array, caller-buffer or owned |

### Cascade is a recipe, not a feature

ecstatic does **not** auto-despawn sources when a target dies. Cascade is what you write,
with a reverse query, **before** despawning the target — which keeps it visible at the
call site, immediate, and with a cleanup seam intact. This reflects pillar 11: the caller
owns every mutation site and can instrument it. Two forms, by whether children hold foreign
resources:

```typescript
// 1. Plain cascade — capture the sources, then despawn target and children.
// Bucket removal is an O(1) hash delete per child, so despawn order doesn't affect
// complexity — O(S) total either way. Target-first is marginally cheaper: dropping
// the target's bucket up front leaves the children no reverse entry to remove.
const children = getSources(world, ChildOf, vehicleId);
despawn(vehicles, vehicleId);
despawnMany(world, children);

// 2. Cascade with cleanup — querySources gives typed storage to release foreign handles.
// The target must stay alive for the walk; each despawn removes its source from the
// still-live bucket with an O(1) hash delete, so this form is O(S) total like form 1.
querySources(world, ChildOf, vehicleId, (e) => {
  gameObjects.delete(get(world, e.id, GameObject.root)); // release foreign handle
  despawn(world, e.id); // safe despawn-during-iteration
});
despawn(vehicles, vehicleId);
```

No automatic cascade. The recipe keeps despawns immediate and gives foreign-resource
children a cleanup seam. The cost: forget the recipe and a source holds a dead required
target (detectable in debug builds; see [Target despawn behavior](#target-despawn-behavior)).

### Reacting to a broken link without a cascade

`getTarget` returns `undefined` for a dead target; `querySources` no longer visits the
source. Systems find orphans by querying, not through callbacks.

## Target despawn behavior

Target despawn drops the dying target's reverse-map entries in O(R) (one map delete per
registered relation); sources are never visited. Sources' SoA columns and bitmasks are
untouched — `getTarget` returns `undefined` via the generation check. `despawnMany(world)`
resets the reverse map in one step instead of probing per entity.

Target-despawn cleanup is **not** gated by the despawned entity's per-archetype relation
flag — any entity can be a target. It runs whenever the world has any relation registered.
Source-despawn cleanup _is_ gated by the source archetype's flag.

To act on a target's death, capture sources first (the [cascade recipe](#cascade-is-a-recipe-not-a-feature)).
Querying after despawn returns nothing. Invariant: capture before the bucket disappears;
despawn order is a marginal performance choice (target-first drops the bucket once instead
of S individual hash deletes — both orders are O(S)).

**Debug aid.** Iterating a source whose required relation points at a dead target is a
likely "forgot the cascade recipe" bug. `getTarget` always performs a generation check
and returns `undefined` for a dead target — the check is unconditional and never stripped,
even under `NDEBUG`.

## Type-level design

### Relation type

Relations reuse the real `Component` brand, expose `target` as a visible field, and ride a
relation-only phantom slot for the target constraint:

```typescript
// A unique-symbol slot (parallel to __ecs_component_meta), carrying the target
// constraint tuple. Present only on relations — it is the relation discriminator.
declare const __ecs_relation_meta: unique symbol;

type Relation<
  N extends string = string,
  T extends object = object,
  Constraints extends Component[] = [],
> = Component<N, T & { target: EntityId }> & {
  readonly [__ecs_relation_meta]: { constraints: Constraints };
};
```

`Relation` _is_ a `Component<N, T & { target: EntityId }>` (intersection, not a parallel
brand), so it is Component-assignable and slots into `Archetype<Comps, Optionals>` tuples
with no change to the `Archetype` type. Making `target` part of the field type means:

- `FieldsOf<typeof ChildOf>` → `{ offsetX: number; offsetY: number; target: EntityId }`
- `get(storage, id, ChildOf.target)` is typed `EntityId` with no cast.

The `__ecs_relation_meta` slot is additive, and its presence is what distinguishes a
relation from a plain component (the transform reads it via the phantom `constraints`
property).

### `relation()` overloads

The second argument is discriminated by shape — a constraint **array** or a defaults
**object**:

```typescript
function relation<N extends string>(name: N): Relation<N, {}, []>;

function relation<N extends string, Comps extends Component[]>(
  name: N,
  constraints: [...Comps],
): Relation<N, {}, Comps>;

function relation<N extends string, T extends object>(name: N, defaults: T): Relation<N, T, []>;

function relation<N extends string, Comps extends Component[], T extends object>(
  name: N,
  constraints: [...Comps],
  defaults: T,
): Relation<N, T, Comps>;
```

An object literal (`{ damage: 0 }`) matches the defaults overload but not `Component[]`;
an array literal (`[Position]`) matches the constraints overload. Empty `[]` and `{}`
differ, so there is no ambiguity. When no constraints are given the tuple is `[]`, and
the `With<[]>` target type below admits every `EntityId` by structural subtyping.

### Write-site constraint enforcement

`target` reads back as plain `EntityId` (you cannot constrain what an opaque cross-archetype
read hands you), but every **write** to a relation's `target` is typed `With<Constraints>`:

```typescript
type RelationConstraints<R extends Relation> =
  R extends Relation<string, object, infer C> ? C : never;

/**
 * `With<C>` accepts a single Component or a readonly Component[] tuple.
 * Any EntityId whose archetype's component presence map includes every constraint
 * component satisfies it by structural subtyping.
 */
type With<C extends Component | readonly Component[]> = EntityId & {
  readonly [__ecs_entity_meta]: {
    components: PhantomComponents<EntityId> & {
      [K in C extends readonly Component[] ? C[number] : C as PhantomName<K>]: true;
    };
  };
};
```

`With<Constraints>` types the `target` in its two write positions:

- **Spawn overrides** — `SpawnOverrides` detects `__ecs_relation_meta` and types the
  relation's `target` override as `With<Constraints>`.
- **`link`'s `target` parameter** — typed `With<RelationConstraints<R>>`, so a
  wrong-shaped target is a compile error at the call site. `link`'s optional `values`
  covers the relation's data fields only; it carries no `target` key (the parameter does).

Conversely, `set`'s patch type for a relation **omits** `target` (it cannot be written
through `set`), so there is no third position to specialize and no way to bypass index
maintenance via the data-write path.

An actual `EntityId<Enemy>` carries a _derived_ `components` presence map —
`{ Position: true; Health: true; … }`. `With<[...]>` requires that map to include every
constraint component, so a target missing one is a compile error, while a target that has
them (plus extras) satisfies it by structural subtyping. Constraints are **compile-time
only**: they erase to nothing in the emitted JavaScript and cost zero at runtime. The
descriptor still stores `constraints` for the transform to read; the runtime never
enforces them.

**Round-tripping through `getTarget` needs no cast.** `getTarget` returns `With<[...]>` —
the constraint is preserved on the dedicated accessor. Forwarding its result into `link`
typechecks directly: `link(world, b, R, getTarget(world, a, R)!)`. The raw `get(id,
Rel.target)` path erases constraints to plain `EntityId`; only that low-level read→write
seam requires a cast.

## Internal storage

### Relation metadata

Stored alongside component metadata on the descriptor. `RelationDescriptor extends
ComponentDescriptor`, so existing code that reads component metadata still works.
Relation-specific fields are read via a `getRelationMeta(rel)` accessor that returns
`RelationDescriptor | undefined` (checks the `isRelation` flag):

```typescript
interface RelationDescriptor extends ComponentDescriptor {
  isRelation: true;
  constraints: ComponentDescriptor[]; // components the target must have (empty = any)
}
```

### SoA column for the target

One-to-one: `target[i]: number` — a single EntityId stored as a regular SoA column,
alongside any data fields.

### Reverse map

One new structure. Two levels, flat per target:

```text
reverseMap: relation → targetEntityIndex → Map<sourceEntityIndex, Storage>
```

- **Entity indices, not dense indices.** Dense indices change on swap-and-pop; entity
  indices are stable for the entity's lifetime. The dense index is resolved at query time
  via the source archetype's sparse map — O(1) per source, no bookkeeping on despawn.
- **Storage as the bucket value, no per-archetype level.** Each source maps directly to
  its own storage, so iteration reads the callback's storage from the entry and
  insert/remove skip a whole per-archetype descent. Sources from different archetypes
  interleave in hash order; the filtered `querySources` path caches the resolved matcher
  behind a storage-identity compare, refreshed only when the storage changes between
  entries.
- **Single-storage flag.** Records the sole storage that has ever sourced the relation
  in this world, degraded to `false` once sources span multiple storages. Filtered
  `querySources` reads it once per call to resolve the matcher outside the loop — a
  compare-free per-element loop for the common single-source-archetype case.
- **`maxTargetIndex` watermark.** Raised when a target index gets its first reverse
  entry. Despawn skips target-side cleanup for any entity above it, keeping the
  no-relations despawn path free of unnecessary data structure checks.
- Maintained incrementally on `spawn` / `link` (insert, plus remove of the previous
  target on retarget) and `unlink` / source-despawn / target-despawn (remove via O(1)
  hash delete). Removal is a hash delete, never a scan or swap-and-pop, so bulk mutations
  (retarget-all, unlink-all, cascade despawn) are O(S) total even on a high-fan-in target
  — 1000 sources on one boss tear down in 1000 hash deletes.
- **Allocation: once per target, retained.** A target's first reverse entry allocates
  its bucket; emptied buckets are kept, not dropped, so attach/detach churn on the same
  target never reallocates. Steady-state `link` / `unlink` / re-link are allocation-free
  (pinned at 0 by the allocation gate). The remaining cost is first-link on a _new_
  target — budget for frames where many targets acquire their first source. Trade-off:
  empty buckets and the flag slot stay resident until a full reverse-map reset
  (`despawnMany(world)` / world destroy).

The source's archetype is always known at mutation time (source entity → sparse map →
archetype), so storing the storage in the bucket adds no extra lookup.

## Error behavior

| Operation              | Stale/invalid source ID          | Stale/invalid target ID                                                 | Other                                                                                                       |
| ---------------------- | -------------------------------- | ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `relation`             | N/A                              | N/A                                                                     | errors if `target` declared in defaults                                                                     |
| `spawn` (req relation) | N/A                              | **Errors** ¹ ("stale target ID")                                        | compile error if target omitted; constraint shape checked at compile time                                   |
| `spawn` (opt relation) | N/A                              | **Errors** ¹ ("stale target ID") if target provided                     | birth-links when target provided; no-op when omitted                                                        |
| `link`                 | **Errors** ¹ ("stale entity ID") | **Errors** ¹ ("stale target ID")                                        | `target` is a required parameter (compile-time); field values stored by reference                           |
| `unlink`               | **Errors** ¹ ("stale entity ID") | N/A                                                                     | **Errors** if relation is required; **no-op** if already unlinked                                           |
| `enable` (relation)    | **Errors** ¹                     | N/A                                                                     | **rejected** — compile error; runtime error in dynamic fallback ("relations toggled via link()/unlink()")   |
| `disable` (relation)   | **Errors** ¹                     | N/A                                                                     | **rejected** — compile error; runtime error in dynamic fallback ("relations toggled via link()/unlink()")   |
| `set` (`.target`)      | **Errors** ¹                     | N/A                                                                     | **rejected** — compile error; runtime error in dynamic fallback ("cannot write relation target — use link") |
| `get` (`.target`)      | **Errors** ¹ ("stale entity ID") | returns the raw stored id (no check)                                    | **Errors** under `!NDEBUG` if the relation is optional and unlinked (standard optional-get gate)            |
| `getTarget`            | returns `undefined`              | returns `undefined` (dead/unlinked)                                     | N/A                                                                                                         |
| `querySources`         | N/A                              | no matches (generation-checked — a stale/recycled target never aliases) | empty results on unregistered relation                                                                      |
| `getSources`           | N/A                              | empty list (generation-checked)                                         | empty list on unregistered relation                                                                         |
| `hasSources`           | N/A                              | returns `false` (generation-checked)                                    | returns `false` on unregistered relation                                                                    |
| `countSources`         | N/A                              | returns `0` (generation-checked)                                        | returns `0` on unregistered relation                                                                        |

¹ Checked builds only: the stale-ID check is gated by `!NDEBUG` and stripped from NDEBUG
builds (the entity-validation contract in `docs/pillars.md`, pillar 5). Unmarked checks —
including `getTarget`'s dead-target check and the `querySources` family's target generation
checks — are unconditional and never stripped.

## Performance characteristics

| Operation              | Cost | Notes                                                                                                                                                         |
| ---------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `link` (attach)        | O(1) | write target + reverse-map insert (+ set bit if optional); field values stored by reference                                                                   |
| `link` (retarget)      | O(1) | write target + reverse-map insert + hash delete from previous target's bucket                                                                                 |
| `unlink`               | O(1) | clear bit + clear target + reverse-map hash delete                                                                                                            |
| `get` / `getTarget`    | O(1) | read SoA column (+ alive check for `getTarget`)                                                                                                               |
| `hasSources`           | O(1) | single existence check on the target's bucket after gen-check + 2-level descent                                                                               |
| `countSources`         | O(S) | S = sources for this (relation, target); walks the target's bucket counting entries                                                                           |
| `querySources`         | O(S) | target gen-check + 2-level reverse-map descent then per-source sparse resolve                                                                                 |
| `getSources`           | O(S) | same walk, collecting IDs; one array allocation when `out` is omitted, zero when provided                                                                     |
| Source despawn cleanup | O(1) | hash delete from the target's bucket, per relation the source carries                                                                                         |
| Target despawn cleanup | O(R) | drop the target's whole source bucket — one map delete per registered relation, the S sources are never visited; gated by a world-level "has relations" check |

Maintenance costs (retarget, unlink, source-despawn) are all O(1) per source (hash delete).
Reverse query is O(S) where S = sources for the (relation, target) pair. Paid only by
entities that use relations.

## Deferred layers

The following features are **not yet implemented** but are designed to build cleanly on
the reverse-map core infrastructure. They are deferred, not rejected, until a real
workload shows the core is insufficient.

### Compositional `pair()` filter term

`querySources` covers the dominant reverse-query shape — sources of a `(relation,
target)`, narrowed by component filters. A `pair(relation, target)` term inside an
ordinary `each` / `query` filter would add two shapes `querySources` cannot express:

- **`none: [pair(R, T)]`** — forward iteration _excluding_ the sources of `T` ("all
  enemies NOT targeting the player"). A forward scan with a per-source predicate, not a
  reverse-bucket walk. Expressible today as `each(enemies, fn)` with an
  `if (getTarget(world, e, R) === T) return;` guard.
- **Multiple relation terms** — `all: [pair(R1, T1), pair(R2, T2)]` (two relations ANDed)
  or `any: [pair(R, T1), pair(R, T2)]` (a target union). Expressible as a `querySources`
  on the most selective term plus `getTarget` checks, or one `querySources` call per
  target.

Both are rare and callback-expressible, so `pair()` is deferred — and can be added later
as a pure filter term without disturbing `querySources`.

### Join iteration

`each(storage, { join: Rel }, (src, si, tgt, ti, entity) => …)` — a five-parameter
callback that pairs each source with its target, with both archetypes' SoA reads contiguous
via world-level **pair groups**. The committed core already lets you read a target's data
during forward iteration — resolve `getTarget` and read across archetypes manually. Join
is the optimization that makes that contiguous and ergonomic. **Build it when manual target
resolution shows up in a profile**, not before.

### One-to-many relations

A source linking many targets. The zero-allocation representations from literature on
entity component systems:

- **Known small N** → N scalar columns (`target0[i] … targetN[i]`), no nesting.
- **Unbounded** → an implicit linked list threaded through scalar columns (`first[i]`,
  `next[i]`).

Most one-to-many needs are better served first by a **reverse one-to-one** queried with
`querySources` / `getSources` (e.g. model "an enemy's aggressors" as each aggressor's
one-to-one `Targets → enemy`). A first-class `relationMany` earns its place only when a
source needs ordered, owned, per-edge target data — defer until that case is real.

## Not in scope (permanent)

- **Hierarchies** — no depth tracking, no `propagate()`, no ordered traversal.
- **Cycle detection** — the user's responsibility. Creating A→B→A does not error.
- **Relation-as-archetype-key** — relations don't affect archetype identity. No
  fragmentation from relation presence.
- **Wildcard queries** — no "all entities with any relation" or "all entities targeted by
  anything." `querySources` / `getSources` require a specific `(relation, target)`. The
  reverse map supports targeted lookups, not open-ended discovery.
- **Reactive hooks** — no automatic callbacks on link, unlink, or target despawn. Sources
  are queried explicitly. Consistent with ecstatic's no-lifecycle-hooks stance (see
  `docs/pillars.md`, pillar 11).
- **Serialization** — relations are runtime-only, like the rest of the ECS.
