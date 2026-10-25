# Design pillars

ecstatic is an archetype-based Entity Component System (ECS) for TypeScript. This document is the
design record: what the library is, why, and what it deliberately is not. Read it before proposing a
feature: most "missing" features are deliberate rejections.

[events.md](events.md) covers inter-system communication and the no-observers decision in depth.
[design/archetype.md](design/archetype.md) and [design/relationships.md](design/relationships.md)
cover internals. [cookbook.md](cookbook.md) shows the patterns the pillars assume.

## Contents

- [1. Declare, don't discover](#1-declare-dont-discover)
- [2. Nominal by default, structural escape hatch](#2-nominal-by-default-structural-escape-hatch)
- [3. Immediate operations](#3-immediate-operations)
- [4. One way to do things](#4-one-way-to-do-things)
- [5. Generational entity IDs, always on](#5-generational-entity-ids-always-on)
- [6. Views are ephemeral; IDs are the durable handle](#6-views-are-ephemeral-ids-are-the-durable-handle)
- [7. TypedArray SoA storage — never exposed](#7-typedarray-soa-storage--never-exposed)
- [8. Optionals and tags via bitmask](#8-optionals-and-tags-via-bitmask)
- [9. No GC-visible allocation on a warm world](#9-no-gc-visible-allocation-on-a-warm-world)
- [10. Runtime-first: the unoptimized runtime is the floor](#10-runtime-first-the-unoptimized-runtime-is-the-floor)
- [11. No lifecycle hooks, no observers](#11-no-lifecycle-hooks-no-observers)
- [12. Deterministic](#12-deterministic)
- [13. Portable: runs wherever JavaScript does](#13-portable-runs-wherever-javascript-does)

## 1. Declare, don't discover

Entity shapes are fixed at definition. Components and archetypes are declared upfront; there is no
runtime component add/remove. Pre-declared optional components are the only runtime variability an
entity has.

What this buys:

- **Compile-time verification of every component access.** `get`, `set`, and `each` callbacks are
  all typed against the archetype's declared shape. There is no "component might not be there"
  branch in user code except the one the type system forces you to write for optionals.
- **No migration machinery.** Entities never move between archetypes, so there is no archetype
  graph, no edge caching, no structural-change command queue, and no mid-frame table moves.
- **Memory proportional to the peak live-entity count**, not to entities-ever-spawned.

The escape hatches, in order of preference: optional components for adjectives, `query()` for
cross-archetype behaviors, despawn + respawn for the rare true archetype transition.

### Why static holds up

Most games have an enumerable set of entity shapes: enemies have Position, Health, and AI; bullets
have Position and Velocity. These shapes are known at design time and rarely change at runtime. The
static model maps them directly. The recurring counterarguments:

- **"Entities that change type?"** Despawn + respawn. Explicit and traceable: the old ID dies (its
  generation is invalidated, so `alive()` detects it everywhere), and the new entity is born in its
  real archetype. Safer than implicit migration, where stored references silently follow an entity
  into a shape the holding code never accounted for.
- **"Open-ended composition?"** ecstatic is a library, not an engine. Libraries export reusable
  components; consumers compose their own archetypes from them. Composition happens at declaration
  time, where the type system can verify it.
- **"Finding every entity with component X?"** That is exactly `query()`: the structural escape
  hatch (pillar 2) exists for behaviors no archetype list should have to enumerate.
- **"Runtime variability?"** Pre-declared optionals cover it: a stunned, burning, shielded enemy is
  one archetype and three O(1) bit flips (pillar 8), not eight subtypes.
- **"Isn't this just fat structs?"** No. A fat struct (one array of everything, filtered by a `kind`
  field) pays memory for every field on every entity and cannot compose. Per-archetype
  Structure-of-Arrays (SoA) columns store only declared fields, and `query()` provides cross-shape
  behavior without `kind` dispatch.

## 2. Nominal by default, structural escape hatch

Noun → archetype. Adjective → optional component. Verb → `query()`.

`each(monsters, fn)` names what an entity **is**; `query(world, [Position, Velocity], fn)` matches
what it **carries** and is reserved for genuinely cross-cutting behaviors (movement, rendering,
expiry). This mapping is also the discipline that prevents archetype explosion: a flying, burning
monster is the `Monster` archetype with `Flying` and `OnFire` optionals — never a
`FlyingFireMonster` archetype.

### Named declarations

The nominal pillar extends to the type level:
`class Ship extends Archetype([Position, Health], [Frozen]) {}` declares an archetype whose _name_
is its type, so every derived type (`Storage<Ship>`, `EntityId<Ship>`, `each` views) reads as the
noun it is, in tooltips and in error messages. A class is the one TypeScript construct that binds a
runtime value and a named type in a single declaration; nothing else avoids either a second
declaration or an unreadable structural type. The class is a declaration, not an object:
constructing it is a compile error and a runtime throw, and `archetype()` remains the value
primitive both forms share.

Two consequences are load-bearing:

- **Canonicalization ignores names.** Identical component lists are the same archetype, and the same
  storage, under any number of names. Two nouns that need separate pools declare a distinguishing
  component; a second name alone is not a second pool.
- **Composition is spreads, never subclassing.**
  `class Tank extends Archetype([...Vehicle.components, Cannon], [...Vehicle.optionals]) {}` reuses
  a declared archetype's lists; `as const` component arrays compose the same way.
  `class Tank extends Vehicle {}` is rejected at registration — a class body cannot add components,
  so extending an archetype class could only alias its storage under a second name, and an alias
  that looks like a subtype is a trap. There is no `IsA` relation: an archetype declared from
  another's parts is a sibling pool, and iterating a "base shape" across pools is `query()`'s job:
  the structural escape hatch this pillar names.

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
cross-archetype), and one obvious call for everything else. No builder chains, no query objects, no
chunk handles, no system classes. Functions take values and return values.

When two APIs could cover a use case, one of them goes. Small surface is a feature: it is what keeps
a future optimizer simple (pillar 10) and the docs honest.

## 5. Generational entity IDs, always on

Storage is a sparse set per archetype: dense rows, swap-and-pop deletion, LIFO index freelist, and a
generation counter per index slot. An `EntityId` packs a 20-bit row index and a 10-bit generation
into one 30-bit number, which keeps every ID inside the small-integer range that JavaScript engines
store without allocating (pillar 9).

Every public entity operation validates the generation. The check is always on: there is no opt-in
versioning and no bit-budget tuning. The checks compile out when a bundler defines `NDEBUG`, or
switch off when `globalThis.NDEBUG` is set before ecstatic is first imported. There are no per-call
unchecked variants.

The check has a bound. A slot has 1,023 generations, so a dead ID matches a live entity again once
its slot has been recycled (despawned, then respawned) 1,023 times since the ID was issued. Reuse is
last-freed-first (pillar 12), so a slot that is despawned and respawned every frame gets there in
about 17 seconds at 60 frames per second. Code that checks `alive()` on a held ID every frame sees
the death and never reaches the repeat. The exposed case is an ID held unchecked for longer than
that: a delayed callback, a save file, a late network message.

One deliberate exception: `despawn` of a stale ID is a defined no-op, always, not gated. Deferred
cleanup and multi-system teardown despawn IDs they cannot know are still alive; that pattern is
correct, not an error.

## 6. Views are ephemeral; IDs are the durable handle

The `e` view inside an `each()`/`query()` callback is valid only for the current callback invocation
— swap-and-pop reuses rows, so a stored view silently rebinds to another entity. Anything that
outlives the callback goes through `EntityId` + `alive()`.

The same rule forbids suspending inside a callback: an `async` callback typechecks (an
`async (e) => …` is assignable to a `(e) => void` parameter) but every `await` is a suspension point
after which the view may be rebound. Complete callbacks synchronously; collect IDs and `await`
between passes. [events.md](events.md#never-await-inside-a-callback) covers the pattern.

## 7. TypedArray SoA storage — never exposed

Per archetype, one column per field: numeric fields get TypedArray columns (`Float64Array` by
default; width markers like `i16()` opt into narrower types), ref and string fields get plain array
columns. Rows are dense.

Why: dense columns are cache-friendly; per-row access through a single reused view object keeps
property access monomorphic, so V8's inline caches stay hot; there are no per-entity objects at all.

Storage is an implementation detail, never API. The library owns column allocation, growth, and
indexing — users never size an array, never write `Position.x[eid]`, and never see a column.

## 8. Optionals and tags via bitmask

Component presence is one bit in a per-row mask. `enable`/`disable` are O(1) bit flips that never
move the entity — toggling an adjective is not a structural change. Up to 32 optionals and tags per
archetype (native 32-bit bitwise ops).

Filter matching is maintained incrementally: each active filter keeps a per-row `matched` flag
updated on spawn/enable/disable, so iteration reads one boolean per row instead of re-testing masks.

## 9. No GC-visible allocation on a warm world

Hot paths allocate nothing after warmup, so the garbage collector (GC) has nothing to reclaim.
Columns grow by doubling and never shrink; despawned capacity is recycled through the freelist;
`each`/`query` produce no result arrays, no iterator objects, and no per-entity views.

This is settled by measurement, never by review. A red-line allocation gate over the hot paths is
the instrument: it holds every operation to a byte budget that only ratchets down. The gate
**measures, never reasons**: V8's escape analysis can remove an allocation silently, and stop
removing it just as silently, so "that object gets scalar-replaced" is never an acceptable argument.

A few operations carry a nonzero budget: `spawnMany`'s returned ids array is one by design, and a
call-site record literal the engine declines to scalar-replace is another. Every nonzero budget
names what allocates and why it stands.

## 10. Runtime-first: the unoptimized runtime is the floor

Every call is fully correct, and fast, without a build-time optimizer. A build-time optimizer is
planned for peak performance: it would inline `each`/`query` loops and other calls at their call
sites. It will never be needed for correctness. The discipline stated outright: **no API may exist
whose correctness depends on the optimizer.**

What the optimizer must do to stay in lockstep with the runtime:

- Extract its codegen bodies from the runtime source. Hand-built syntax trees are reserved for
  call-site inlining, and every hand-built site names the runtime function it mirrors.
- Pass the same test suite run three ways: unoptimized, optimized, and `NDEBUG`-stripped. Any
  behavioral divergence then fails the same assertion twice.

## 11. No lifecycle hooks, no observers

The most deliberate pillar. It rests on three premises:

1. **Immediate operations remove the seam observers fill.** Deferred ECSs fire lifecycle callbacks
   at their flush point — batched and ordered. An immediate ECS would fire them mid-frame at
   arbitrary call sites, which generates reentrancy bugs.
2. **Static archetypes remove most of what observers observe.** There is no "component added" event;
   the only structural events are spawn/despawn/enable/disable — all caller-initiated, at lines the
   caller owns.
3. **The patterns cover the use cases.** Flag + system covers gameplay reactions. A `Dead` flag,
   `none: [Dead]` filters, and an end-of-frame sweep cover cleanup ordering. No despawn happens
   behind your back; even relationship cascade is a recipe you write. So every mutation already
   passes through a line you own and can instrument.

"Entered a query" can only mean spawn or `enable()` here — caller-owned sites where flag + system
already works with zero machinery. Engines embedding ecstatic wrap it: their own spawn/kill/equip
APIs are the mutation sites, so they fire their own events there.

Consequence for serialization (a future module, out of core): observer-based delta capture is
structurally unavailable, by design. Serialization is snapshot-first (declared schemas make world
snapshots nearly free), with two-phase restore so entity references resolve. A delta/networking tier
would capture ops explicitly at caller-owned mutation sites.

The full argument, including the decision framework for "do I need an event here?", is in
[events.md](events.md).

## 12. Deterministic

The same sequence of world operations yields the same entity IDs (including generational reuse), the
same `each`/`query`/`querySources` iteration order, and the same results — across runs and across
runtimes.

Iteration order is a specified function of spawn/despawn history, not an implementation detail:

- `each` walks dense rows from last to first.
- Despawn fills the hole with swap-and-pop: the last row moves into the vacated slot.
- The freelist is LIFO: the next spawn reuses the most recently freed index with an incremented
  generation.

The runtime never reads wall clock, randomness, hash order, or platform state. Float math is
whatever the engine gives — no fixed-point promise; that is the game's concern.

Enforcement: lint restrictions on nondeterminism sources (`Math.random`, `Date.now`, `performance`,
timers) in `src/ecstatic/`, plus a replay test that drives the same op sequence into two
independently created worlds and asserts identical ID and iteration-order traces.

## 13. Portable: runs wherever JavaScript does

`src/ecstatic/` uses only ECMAScript — no Node builtins, no `process`, no DOM. One build serves
browsers, Node, workers, and edge runtimes; client simulation code is reusable on the server
unchanged. The bundler plugin under `src/plugin/` runs at build time on Node and is outside this
pillar.

Debug checks strip via a bundler `define` of `NDEBUG`, or switch off when `globalThis.NDEBUG` is set
before the first import (pillar 5). No runtime-specific opt-out mechanism exists.

Enforcement: `tsconfig.build.json` sets `types: []` so `src/ecstatic/` typechecks against pure ES
with no `@types/node`; oxlint restricts Node globals, Node imports, and nondeterminism sources in
`src/ecstatic/`; and a portability test bundles `src/ecstatic/index.ts` with esbuild for a browser
target and runs it in a bare `node:vm` context (no `process`, no Node builtins).
