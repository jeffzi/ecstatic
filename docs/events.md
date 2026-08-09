# System Communication in ecstatic

How do independent systems (movement, combat, AI, rendering) communicate in a static archetype
ECS with immediate operations? This document describes the communication patterns, provides a
decision framework for choosing between them, and explains why some common ECS patterns
(lifecycle hooks, command buffers) don't apply.

For design motivation, see [pillars.md](pillars.md). For internal data structures, see
[design/archetype.md](design/archetype.md). For production-ready versions of the patterns, see
[cookbook.md](cookbook.md).

All code examples below assume the following imports:

```typescript
import {
  alive,
  component,
  components,
  despawn,
  disable,
  each,
  enable,
  get,
  getResource,
  query,
  ref,
  register,
  resource,
  set,
  setResource,
  spawn,
} from "ecstatic";
```

`EntityId` and the other types are importable via `import type` from `"ecstatic"`.

## Architecture context

Two properties of ecstatic shape how systems communicate:

1. **Static archetypes.** Entity shapes are fixed at definition. Components can't be added or
   removed at runtime — only pre-declared optionals can be toggled. This means there's no
   structural event to react to (no "component added" hook), only state changes within a fixed
   layout.

2. **Immediate operations.** `spawn()`, `despawn()`, `enable()`, `disable()` all take effect
   immediately. The caller knows exactly when a state change happens and can handle consequences
   inline. There's no deferred submission, no batch processing, no "end of frame"
   synchronization point.

Together, these properties favor **direct state mutation** over event-driven patterns. Systems
communicate by writing to shared component columns, toggling optional flags, and checking entity
status — not by publishing events and subscribing to callbacks.

## Communication patterns

### A. Shared mutable state

The most common pattern. Multiple systems read and write the same component columns.
Communication happens implicitly through data: one system writes a value, another system reads
it.

**When to use:** Continuous data flow where the producer and consumer operate on the same
components. Movement, physics, rendering — any system that transforms component data.

**Example — movement system:**

```typescript
query(world, [Position, Velocity], (e) => {
  e.Position.x += e.Velocity.vx * dt;
  e.Position.y += e.Velocity.vy * dt;
});
```

The movement system writes to Position. The rendering system reads Position. No explicit
communication — the shared column IS the communication channel.

**Example — damage + death:**

```typescript
// Damage system: apply DoT to burning enemies
each(enemies, { all: [OnFire] }, (e) => {
  e.Health.hp -= 5;
});

// Death system: despawn dead enemies (runs after damage)
each(enemies, (e) => {
  if (e.Health.hp <= 0) {
    despawn(world, e.id);
  }
});
```

The damage system writes `hp`. The death system reads `hp`. The communication is the shared
`Health.hp` column. System ordering matters — the death system must run after the damage system.

**Tradeoffs:**

- Zero overhead, no indirection
- Tight coupling: both systems must know the component layout
- Causality is implicit — "who changed this?" requires reading the code
- System ordering is the user's responsibility

### B. Optional component flags

Use optional components as state machine signals. One system enables a flag; other systems react
by filtering on it. This is the primary mechanism for inter-system signaling in ecstatic.

**When to use:** Binary or multi-state conditions that other systems need to react to. Status
effects (stunned, on fire, shielded), lifecycle states (alive, dying), AI states (aggressive,
fleeing).

**Example — stun + combat:**

```typescript
// Stun system: stun enemies hit by stun grenades
each(enemies, (e) => {
  if (wasHitByStun(e)) {
    enable(enemies, e.id, Stunned);
  }
});

// Combat system: skip stunned enemies (they can't attack)
each(enemies, { none: [Stunned] }, (e) => {
  performAttack(e);
});

// Recovery system: clear stun after duration
each(enemies, { all: [Stunned] }, (e) => {
  if (stunExpired(e)) {
    disable(enemies, e.id, Stunned);
  }
});
```

The stun system enables a flag. The combat system filters it out. The recovery system clears it.
Each system is independent — they communicate through the bitmask, not through direct calls.

**Data-carrying optionals** extend this pattern beyond boolean flags:

```typescript
const Shield = component("Shield", { hp: 50, defense: 10 });
// ...declared as optional on the archetype

// Equipment system: equip shield with custom stats
enable(enemies, entity, Shield, { hp: 75, defense: 15 });

// Combat system: damage reduces shield first
each(enemies, { all: [Shield] }, (e) => {
  e.Shield.hp -= incomingDamage;
  if (e.Shield.hp <= 0) {
    disable(enemies, e.id, Shield);
  }
});
```

**Tradeoffs:**

- O(1) enable/disable (bit flip + optional column fill)
- Safe mid-iteration — toggling doesn't invalidate indices
- Type-safe — the compiler validates that the component is optional on the archetype
- Composable — multiple flags can be combined in filters (`all: [OnFire], none: [Stunned]`)
- Limited to 32 optionals and tags per archetype (one bit each in the presence mask)

**When data optionals are a poor fit:** A filtered `each` still scans every row in the archetype
and branches on its matched flag, so very low match rates waste cycles, and the optional's
columns hold a slot for every entity whether enabled or not. If only a small fraction of
entities will ever have the optional enabled at any given time, consider a separate archetype:

```typescript
// Poor fit: Shield enabled on <5% of 10,000 enemies — 95% of the scan is branch misses
class Enemy extends Archetype([Hp, Position, Velocity], [Shield]) {}

// Better: dedicated archetype, dense iteration, no wasted scans
class Enemy extends Archetype([Hp, Position, Velocity]) {}
class ShieldedEnemy extends Archetype([Hp, Position, Velocity, Shield]) {}
```

The threshold is workload-dependent — measure before splitting an archetype over it.

### C. Resources (singletons)

Global state that isn't tied to any entity: frame time, input state, camera position, audio
manager, global counters. Resources are per-world singletons.

**When to use:** Data that every system needs but no entity owns. Configuration, timing, input,
global accumulators.

**Example — frame time:**

```typescript
const Time = resource("Time", { dt: 0, elapsed: 0 });

// Game loop: update time resource each frame
setResource(world, Time, { dt: delta, elapsed: elapsed });

// Movement system: reads dt from resource
const time = getResource(world, Time);
query(world, [Position, Velocity], (e) => {
  e.Position.x += e.Velocity.vx * time.dt;
});
```

**Tradeoffs:**

- Simple access pattern (get/set)
- Decouples systems from global variables
- Not entity-scoped — can't query or iterate resources
- Easy to overuse — if something belongs on an entity, put it on an entity

### D. Entity links

Store an EntityId in a component field to reference another entity. The generational ID system
guarantees safe stale detection via `alive()`.

**When to use:** Persistent cross-entity relationships. Targeting, ownership, parent-child,
follow/track behaviors.

**Example — homing projectile:**

```typescript
const Target = component("Target", { entityId: ref<EntityId>() });

// Spawn a homing missile targeting an enemy
const missile = spawn(missiles, {
  Target: { entityId: enemyId },
  Position: { x: launcherX, y: launcherY },
});

// Homing system: track target or self-destruct
each(missiles, (e) => {
  const targetId = e.Target.entityId;
  if (targetId === undefined || !alive(world, targetId)) {
    despawn(world, e.id); // target died — remove missile
    return;
  }
  // steer toward target — world-form get resolves the archetype automatically
  const tx = get(world, targetId, Position.x);
  const ty = get(world, targetId, Position.y);
  // ... compute steering toward (tx, ty) ...
});
```

`ref<EntityId>()` is the documented default for entity-link fields: unset reads `undefined`
(forcing the guard above), rather than a fake ID `0` that would pass typechecking straight into
`alive()`. For a link that's always set at spawn time and never needs the guard,
`0 as EntityId` is a documented perf alternative — a pure-scalar column (see
[cookbook: entity links vs. relations](cookbook.md#entity-links-vs-relations)).

**Tradeoffs:**

- Direct reference, no global state
- Generational IDs catch stale references (target despawned between frames)
- No automatic notification when the target is destroyed — must poll with `alive()`
- Cross-archetype data lookup requires resolving the entity's archetype and dense index

### E. Transient event queues

A userland pattern for one-shot events that need to cross system boundaries. A producer system
populates a queue during its iteration; consumer systems read it; the queue is cleared at the
end of the frame (or at the start of the next).

**When to use:** Events that multiple unrelated systems need to react to. Collision pairs,
damage events, audio triggers, achievement notifications. Any case where the producer shouldn't
know about the consumers.

**Example — damage events:**

```typescript
// Shared event queue (module-level or passed explicitly).
// Targets may belong to any archetype — world-form alive/get/set handle resolution.
const damageEvents = new Map<EntityId, { amount: number; source: EntityId }>();

// Combat system: record damage events
each(projectiles, (e) => {
  const target = e.Target.entityId;
  if (target !== undefined && alive(world, target) && checkCollision(e, target)) {
    damageEvents.set(target, { amount: e.Damage.value, source: e.id });
    despawn(world, e.id);
  }
});

// Health system: apply damage from events
for (const [target, event] of damageEvents) {
  if (alive(world, target)) {
    const hp = get(world, target, Health.hp);
    set(world, target, Health.hp, hp - event.amount);
  }
}

// VFX system: spawn hit effects from same events
for (const [target, event] of damageEvents) {
  if (alive(world, target)) {
    spawnHitEffect(world, target, event.amount);
  }
}

// End of frame: clear events
damageEvents.clear();
```

The example shows three independent systems reading the same event queue: a producer (combat
system), a health consumer, and a VFX consumer. Each system runs independently of the others —
they communicate only through the shared queue.

**Allocation note:** A `Map` allocates an entry per event and an object per value — GC pressure
that violates the allocation pillar ([pillars.md](pillars.md), "No GC-visible allocation on a
warm world"). For production use, see the
[allocation-free event queue](cookbook.md#allocation-free-event-queue): same pattern, zero GC
pressure after the first frame. The `Map` version here is for clarity.

**Tradeoffs:**

- Fully decouples producers from consumers
- Multiple consumers can read the same events
- Must be cleared manually (easy to forget — causes stale events next frame)
- Requires discipline around when events are produced vs consumed (ordering)
- Not type-checked by the framework — it's a plain data structure
- For data needed only within a single frame, use local variables or a transient queue — not a
  component field that wastes per-entity memory across all frames

### F. Archetype-as-state-machine

For heavy entity type transitions where the source and target have fundamentally different
components, use despawn + respawn. This is the static archetype equivalent of archetype
migration in dynamic ECS systems.

**When to use:** An entity changes its fundamental nature — enemy → corpse, egg → chicken,
building-under-construction → completed-building. The new state has different components than
the old.

**Example — enemy death → corpse:**

```typescript
class Corpse extends Archetype([Position, Sprite, DecayTimer]) {}
const corpses = register(world, Corpse);

// Death system
each(enemies, (e) => {
  if (e.Health.hp <= 0) {
    const x = e.Position.x;
    const y = e.Position.y;
    despawn(world, e.id);
    spawn(corpses, { Position: { x, y } });
  }
});
```

**Tradeoffs:**

- Explicit and traceable — no hidden migration
- Old entity ID is invalidated (detectable via `alive()`)
- Must manually copy shared data (Position in this example)
- Not suitable for frequent transitions (spawn/despawn have per-call cost)

### G. Death-flagging and deferred cleanup

When an entity holds a **foreign resource** — a scene-graph node, a DOM element, a physics body,
a WebGL buffer, a playing sound — that resource must be released when the entity dies. The
handle lives in a component field, and `despawn()`'s swap-and-pop erases that field immediately,
so the release has to happen _before_ the entity is erased.

Unlike deferred-submission ECS systems, ecstatic is immediate: `despawn()` takes effect at the
call site. This pattern defers _cleanup_ via a flag, not despawn execution. The shape: mark the
entity dead with a flag, exclude it from gameplay queries, then release the handle and despawn
in a controlled end-of-frame sweep.

**When to use:** Death needs cleanup that reads the dying entity's data — releasing a foreign
handle, removing it from a spatial index, dropping loot at its position. Also whenever you want
death batched and ordered rather than scattered across mutation sites.

**Example — scene-node cleanup:**

```typescript
const Dead = component("Dead"); // tag, declared as optional on every dieable archetype
const SceneNode = component("SceneNode", { node: ref<DisplayObject>() }); // engine handle

// Death system: mark dead instead of despawning. The entity is still alive and its scene-node
// handle is intact — it just drops out of every `none: [Dead]` query this instant.
each(enemies, (e) => {
  if (e.Health.hp <= 0) {
    enable(enemies, e.id, Dead);
  }
});

// Gameplay systems exclude the dead with a filter — zero per-entity cost. The `none` term is
// compiled into the bitmask matcher, so flipping `Dead` removes the entity from these loops at
// flag-flip time. No `has(id, Dead)` branch in the loop body.
each(enemies, { none: [Dead] }, (e) => {
  performAttack(e);
});

// Cleanup sweep: once per frame, after all gameplay systems. Data is still live here, so the
// handle is readable. Release it, then despawn for real.
each(enemies, { all: [Dead] }, (e) => {
  e.SceneNode.node?.destroy(); // release the foreign resource
  despawn(world, e.id); // safe despawn-during-iteration (reverse scan)
});
```

**Tradeoffs:**

- Cleanup runs in a controlled, ordered place — nothing scattered across mutation sites, no
  mid-frame surprises. This is the same conclusion immediate-mode ECS libraries reach: a queue
  drained at one controlled point per frame.
- A convention, not an invariant. It works only if **every** kill site sets `Dead` (never calls
  `despawn()` directly on a resource-holding entity) and **every** gameplay query excludes
  `none: [Dead]`. Miss one and you leak a handle or process a dead entity for a frame.
- Costs one bit of the 32-bit optional budget per dieable archetype.
- Dead-but-not-despawned entities occupy their slots until the sweep — higher peak occupancy for
  spawn-and-die-same-frame workloads (bullet hell, particles-as-entities).
- Reaches every despawn, because you initiate them all. ecstatic triggers no despawn on your
  behalf — even a relationship cascade is an explicit
  [cascade recipe](design/relationships.md#cascade-is-a-recipe-not-a-feature) you write, so
  cascade-despawned entities pass through a kill site where you set `Dead` like any other. See
  [Why ecstatic has no public observers](#why-ecstatic-has-no-public-observers).

## Decision framework

| Scenario                                 | Pattern                    | Why                               |
| ---------------------------------------- | -------------------------- | --------------------------------- |
| Continuous data flow (movement, physics) | **Shared state**           | Same components, no indirection   |
| Binary state (stunned, alive, on fire)   | **Optional flag**          | O(1) bit flip, filtered iteration |
| Multi-state with data (shield with hp)   | **Data-carrying optional** | Columns + bitmask                 |
| Global config (dt, input, camera)        | **Resource**               | Not entity-scoped                 |
| Persistent cross-entity reference        | **Entity link**            | Generational ID safety            |
| One-shot event (hit, collect, trigger)   | **Transient queue**        | Decouples producer/consumer       |
| Heavy type change (enemy → corpse)       | **Archetype swap**         | Different component sets entirely |
| Foreign-resource cleanup on death        | **Deferred despawn**       | `Dead` flag, sweep, then despawn  |

### Combining patterns

Real systems combine multiple patterns. A typical combat frame might look like:

```text
1. Input system       → writes to MoveInput component       (shared state)
2. AI system          → writes to AITarget component        (shared state + entity link)
3. Movement system    → reads Position + Velocity           (shared state)
4. Collision system   → populates collision event queue     (transient queue)
5. Damage system      → reads collisions, writes hp         (transient queue → shared state)
6. Status system      → enables/disables Stunned, OnFire    (optional flags)
7. Death system       → despawns dead entities              (shared state read)
8. Cleanup            → clears collision event queue        (transient queue lifecycle)
```

The patterns compose naturally because they all operate on the same underlying data — component
columns and entity IDs. No special integration layer is needed.

## Implicit system ordering

ecstatic does not schedule systems. The user calls systems in order, and that order determines
causality:

```typescript
function update(dt: number): void {
  moveSystem(world, dt); // updates Position
  damageSystem(world); // reduces Health
  deathSystem(world); // despawns entities with hp <= 0
  renderSystem(world); // reads Position for drawing
}
```

If `deathSystem` runs before `damageSystem`, entities die a frame late. If `renderSystem` runs
before `moveSystem`, entities render at their old position. **Order is the user's
responsibility.**

This is simpler than automatic dependency resolution (no dependency graph, no scheduling
overhead) but requires the developer to understand the data flow. For most games, the ordering
is obvious and rarely changes.

**Rule of thumb:** If system A writes data that system B reads, A must run before B in the same
frame. If the order doesn't matter (e.g., two systems that read the same data without writing),
they can run in any order.

## Views are ephemeral

The view `e` parameter in `each()` callbacks is valid only for the current callback invocation.
After the callback returns, despawns can reorder the storage via swap-and-pop, invalidating any
stored view. This is a gap in ecstatic's safety model: the type system catches structural
mistakes (wrong component on wrong archetype), and generational IDs catch temporal mistakes
(using a despawned entity), but views are reused per-archetype objects with no branding or
staleness detection.

```typescript
// DANGEROUS: storing view across iterations
let savedE;
each(enemies, (e) => {
  if (isTarget(e)) savedE = e;
});

// Later — a despawn reordered the storage. savedE now accesses a different entity's data.
savedE.Health.hp -= 10; // silent corruption
```

**Rule: never store `e` outside its callback.** If you need to reference an entity later, store
`e.id` (an EntityId) — its generational check detects stale references. Views are the fast path
for _immediate_ field access within a single callback; EntityIds are the safe path for
_deferred_ references.

### Never `await` inside a callback

The same rule forbids suspending mid-iteration. Every `await` inside an `each()`/`query()`
callback is a suspension point: between suspension and resumption, other code can spawn or
despawn entities, reordering the dense rows via swap-and-pop — the view `e` silently rebinds to
a different entity.

TypeScript will not catch this: `async (e) => …` is assignable to a `(e) => void` parameter, so
an accidentally-async callback typechecks and the returned promises are silently dropped.

```typescript
// DANGEROUS: typechecks, but every await may rebind e
each(enemies, async (e) => {
  const choice = await aiService.decide(e.Position.x, e.Position.y);
  e.Velocity.vx = choice.vx; // may write to a different entity's row
});

// Correct: complete the pass synchronously, collect IDs, await between passes
const pending: EntityId[] = [];
each(enemies, (e) => {
  pending.push(e.id);
});
for (const id of pending) {
  const choice = await aiService.decide(id);
  if (alive(enemies, id)) {
    set(enemies, id, Velocity.vx, choice.vx);
  }
}
```

Complete all `each()` callbacks synchronously — `await` _between_ `each()` calls, not inside
them, and re-validate collected IDs with `alive()` after every suspension point.

## Why ecstatic has no public observers

Many ECS libraries expose lifecycle observers — callbacks that fire when an entity spawns,
despawns, or changes components. ecstatic deliberately ships none as public API. The reasons are
specific to this design:

- **Immediate operations remove the seam observers fill.** In a deferred ECS, removals are
  queued and flushed at one point per frame, and lifecycle callbacks fire there — batched,
  ordered, easy to trace. ecstatic is immediate: `despawn()` takes effect at the call site, so a
  mutation-time observer would fire mid-frame at whatever arbitrary point invoked the operation.
  Even libraries with deferred removal warn against reacting at mutation time and recommend a
  queue drained at a controlled point — which is the flag + system pattern.
- **Static archetypes remove most of what observers observe.** Component sets are fixed at
  definition; there is no "component added" event. The only runtime structural events are
  spawn/despawn and optional enable/disable, all of which the caller initiates and can react to
  inline.
- **Deferred despawn covers foreign-resource cleanup.** The one case that genuinely needs
  mutation-time data — releasing a handle before swap-and-pop erases it — is handled by
  [deferred despawn](#g-death-flagging-and-deferred-cleanup) above: mark `Dead`, exclude with
  `none: [Dead]`, release and despawn in a sweep. For despawns you initiate, this is often
  _better_ than an observer — ordered, batched, and aligned with how rendering engines batch
  their own destruction.

For **gameplay reactions** — VFX, sound, UI, analytics, AI transitions — the flag + system
pattern is faster and more explicit: set an optional flag at the mutation, iterate
`{ all: [Flag] }` at a controlled point, react there. Zero per-operation cost, explicit
ordering, natural batching. A `despawn()` that silently triggered N callbacks would be harder to
trace than an explicit sweep.

### No despawns happen behind your back

Deferred despawn is a _convention_ — it works because you set `Dead` at every kill site, so it
only reaches despawns you initiate. ecstatic initiates none on your behalf. The one feature that
could have — an automatic relationship cascade — is instead specified as
[cascade-as-recipe](design/relationships.md#cascade-is-a-recipe-not-a-feature): despawning a
target does not auto-despawn its sources, so you query the sources and despawn them yourself.
Every despawn, cascades included, passes through a kill site where the flag + system and
deferred-despawn patterns already apply.

So no scenario remains that a mutation-time `onDespawn` would uniquely serve. The relationship
system reacts to a target's death through explicit reverse queries, not a callback slot, and no
public observer API is built.

## Common pitfalls

### Redundant empty-archetype guards

`each()` already handles empty archetypes — it checks the entity count internally and skips the
loop. No guard needed:

```typescript
// Redundant — each handles empty archetypes
if (enemies.n > 0) {
  each(enemies, fn);
}

// Correct
each(enemies, fn);
```

### Async callbacks

See [Never `await` inside a callback](#never-await-inside-a-callback). Complete all iteration
synchronously; suspend only between passes, and re-validate IDs with `alive()` afterwards.
