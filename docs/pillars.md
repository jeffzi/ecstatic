# Design pillars

ecstatic is an archetype-based Entity Component System for TypeScript. This document is the
design record: what the library is, why, and what it deliberately is not. Read it before
proposing a feature — most "missing" features are rejections, not gaps.

`docs/events.md` covers inter-system communication and the no-observers decision in depth.
`docs/design/` covers internals. `docs/cookbook.md` shows the patterns the pillars assume.

## 1. Declare, don't discover

Entity shapes are fixed at definition. Components and archetypes are declared upfront; there is
no runtime component add/remove. Pre-declared optional components are the only runtime
variability an entity has.

What this buys:

- **Compile-time verification of every component access.** `get`, `set`, `each` callbacks — all
  typed against the archetype's declared shape. There is no "component might not be there"
  branch in user code except the one the type system forces you to write for optionals.
- **No migration machinery.** Entities never move between archetypes, so there is no archetype
  graph, no edge caching, no structural-change command queue, and no mid-frame table moves.
- **Memory proportional to live entities**, not to entities-ever-spawned.

The escape hatches, in order of preference: optional components for adjectives, `query()` for
cross-archetype behaviors, despawn + respawn for the rare true archetype transition.

### Why static holds up

Most games have an enumerable set of entity shapes: enemies have Position, Health, and AI;
bullets have Position and Velocity. These shapes are known at design time and rarely change at
runtime — the static model maps them directly. The recurring counterarguments:

- **"Entities that change type?"** Despawn + respawn. Explicit and traceable: the old ID dies
  (its generation is invalidated, so `alive()` detects it everywhere), and the new entity is born
  in its real archetype. Safer than implicit migration, where stored references silently follow
  an entity into a shape the holding code never accounted for.
- **"Open-ended composition?"** ecstatic is a library, not an engine. Libraries export reusable
  components; consumers compose their own archetypes from them. Composition happens at
  declaration time, where the type system can verify it.
- **"Finding every entity with component X?"** That is exactly `query()` — the structural escape
  hatch (pillar 2) exists for behaviors no archetype list should have to enumerate.
- **"Runtime variability?"** Pre-declared optionals cover it: a stunned, burning, shielded enemy
  is one archetype and three O(1) bit flips (pillar 8), not eight subtypes.
- **"Isn't this just fat structs?"** No. A fat struct — one array of everything, filtered by a
  `kind` field — pays memory for every field on every entity and cannot compose. Per-archetype
  SoA columns store only declared fields, and `query()` provides cross-shape behavior without
  `kind` dispatch.

## 2. Nominal by default, structural escape hatch

Noun → archetype. Adjective → optional component. Verb → `query()`.

`each(monsters, fn)` names what an entity **is**; `query(world, [Position, Velocity], fn)`
matches what it **carries** and is reserved for genuinely cross-cutting behaviors (movement,
rendering, expiry). This mapping is also the discipline that prevents archetype explosion: a
flying, burning monster is the `Monster` archetype with `Flying` and `OnFire` optionals — never
a `FlyingFireMonster` archetype.

## 3. Immediate operations

`spawn`, `despawn`, `enable`, `disable` take effect at the call site. No command buffers, no
deferred submission, no flush points.

Dynamic-composition ECSs defer structural changes because a mid-iteration archetype move breaks
their iterators. Static archetypes remove the move, and the iteration order makes the remaining
mutations safe by construction:

- **Despawn during iteration** is safe: iteration runs back-to-front, and swap-and-pop fills the
  hole with a row the pass has already visited.
- **Spawn during iteration** appends at the end — which a reverse pass has already passed. New
  entities are deterministically not visited in the current pass.

## 4. One way to do things

Two iteration functions with distinct responsibilities (`each` for archetypes, `query` for
cross-archetype), and one obvious call for everything else. No builder chains, no query objects,
no chunk handles, no system classes. Functions take values and return values.

When two APIs could cover a use case, one of them goes. Small surface is a feature: it is what
keeps the transform simple (pillar 10) and the docs honest.

## 5. Generational entity IDs, always on

Storage is a sparse set per archetype: dense rows, swap-and-pop deletion, LIFO index freelist,
and a generation counter per index slot. An `EntityId` packs a 24-bit row index and a 29-bit
generation into one safe integer (packed multiplicatively — JavaScript bitwise operators
truncate to 32 bits, but 53 safe-integer bits hold the pair comfortably).

Every public entity operation validates the generation. There is no opt-in versioning and no
bit-budget tuning — temporal safety is not the user's problem. The checks compile out under a
single build-time `NDEBUG` define, which is the only opt-out; there are no per-call unchecked
variants.

One deliberate exception: `despawn` of a stale ID is a defined no-op, always, not gated. Deferred
cleanup and multi-system teardown despawn IDs they cannot know are still alive; that pattern is
correct, not an error.

## 6. Views are ephemeral; IDs are the durable handle

The `e` view inside an `each()`/`query()` callback is valid only for the current callback
invocation — swap-and-pop reuses rows, so a stored view silently rebinds to another entity.
Anything that outlives the callback goes through `EntityId` + `alive()`.

The same rule forbids suspending inside a callback: an `async` callback typechecks (an
`async (e) => …` is assignable to a `(e) => void` parameter) but every `await` is a suspension
point after which the view may be rebound. Complete callbacks synchronously; collect IDs and
`await` between passes. `docs/events.md` covers the pattern.

## 7. TypedArray SoA storage — never exposed

Per archetype, one column per field: numeric fields get TypedArray columns (`Float64Array` by
default; width markers like `i16()` opt into narrower types), ref and string fields get plain
array columns. Rows are dense.

Why: dense columns are cache-friendly; per-row access through a single reused view object keeps
property access monomorphic, so V8's inline caches stay hot; there are no per-entity objects at
all.

Storage is an implementation detail, never API. The library owns column allocation, growth, and
indexing — users never size an array, never write `Position.x[eid]`, and never see a column.

## 8. Optionals and tags via bitmask

Component presence is one bit in a per-row mask. `enable`/`disable` are O(1) bit flips that
never move the entity — toggling an adjective is not a structural change. Up to 32 optionals and
tags per archetype (native 32-bit bitwise ops).

Filter matching is maintained incrementally: each active filter keeps a per-row `matched` flag
updated on spawn/enable/disable, so iteration reads one boolean per row instead of re-testing
masks.

## 9. No GC-visible allocation on a warm world

Hot paths allocate nothing after warmup. Columns grow by doubling and never shrink; despawned
capacity is recycled through the freelist; `each`/`query` produce no result arrays, no iterator
objects, and no per-entity views.

This is enforced, not aspired to: the benchmark pipeline runs a red-line allocation gate over
the hot paths. The gate **measures, never reasons** — V8's escape analysis can remove an
allocation silently, and stop removing it just as silently, so "that object gets scalar-replaced"
is never an acceptable argument.

The one budgeted exception is `spawnMany`'s returned ids array. The budget only ratchets down.

## 10. Runtime-first: the untransformed runtime is the floor

Every call is fully correct — and fast — without the build-time transform. The ttsc plugin
exists for peak performance (`each`/`query` loop fusion, call-site inlining), never for
correctness. The discipline stated outright: **no API may exist whose correctness depends on the
transform.**

What keeps the two in lockstep:

- Codegen bodies are extracted from the runtime source; hand-built AST is reserved for call-site
  fusion, and every hand-built site names the runtime function it mirrors.
- The same test suite runs three ways — untransformed, transformed, and `NDEBUG`-stripped — so
  any behavioral divergence fails the same assertion twice.

## 11. No lifecycle hooks, no observers

The most deliberate pillar. It rests on three premises:

1. **Immediate operations remove the seam observers fill.** Deferred ECSs fire lifecycle
   callbacks at their flush point — batched and ordered. An immediate ECS would fire them
   mid-frame at arbitrary call sites, which is a reentrancy bug generator, not a feature.
2. **Static archetypes remove most of what observers observe.** There is no "component added"
   event; the only structural events are spawn/despawn/enable/disable — all caller-initiated,
   at lines the caller owns.
3. **The patterns cover the use cases.** Flag + system for gameplay reactions; a `Dead` flag,
   `none: [Dead]` filters, and an end-of-frame sweep for cleanup ordering; and the guarantee
   that no despawns happen behind your back — even relationship cascade is a recipe, not a
   feature — means every mutation already passes through a line you own and can instrument.

"Entered a query" can only mean spawn or `enable()` here — caller-owned sites where flag +
system already works with zero machinery. Engines embedding ecstatic wrap it: their own
spawn/kill/equip APIs are the mutation sites, so they fire their own events there.

Consequence for serialization (a future module, out of core): observer-based delta capture is
structurally unavailable, by design. Serialization is snapshot-first — declared schemas make
world snapshots nearly free — with two-phase restore so entity references resolve. A
delta/networking tier would capture ops explicitly at caller-owned mutation sites.

The full argument, including the decision framework for "do I need an event here?", is in
`docs/events.md`.
