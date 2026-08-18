# Cookbook

Reusable userland patterns for ecstatic. These are not part of the core API — they're lightweight
utilities you copy into your project and adapt.

For communication patterns, see [events.md](events.md).

All code examples below assume the following imports:

```typescript
import {
  alive,
  archetype,
  Archetype,
  component,
  components,
  countSources,
  despawn,
  despawnMany,
  disable,
  disableMany,
  each,
  enable,
  enableMany,
  get,
  getResource,
  getSources,
  getTarget,
  has,
  hasAny,
  hasSources,
  link,
  query,
  querySources,
  ref,
  register,
  relation,
  resetResource,
  resource,
  setResource,
  spawn,
  spawnMany,
  unlink,
} from "ecstatic";
```

`EntityId` is available as a type from the same import.

## Recommended project layout

ecstatic has no system concept — a system is a plain function that calls `each()` or `query()`. This
is intentional: plain functions are easy to test, easy to reorder, and need no registration or base
class.

The recommended convention is one `schema.ts` for shared definitions (components, tags, archetypes)
and one system per file, all called in order from a single `update()`:

```text
src/
  schema.ts             shared components and archetypes
  main.ts               world setup, update loop
  systems/
    input.ts            reads platform input, writes to components
    movement.ts         Position += Velocity * dt
    combat.ts           damage, status effects, projectile hits
    death.ts            marks dead entities for deferred despawn
    cleanup.ts          flushes despawn list, clears transient queues
```

Each system file exports one function that takes `world` (and any other state it needs):

```typescript
import { getResource, query } from "ecstatic";
import { Time, Position, Velocity } from "./schema";

export function movementSystem(world: World): void {
  const dt = getResource(world, Time).dt;
  query(world, [Position, Velocity], (e) => {
    e.Position.x += e.Velocity.vx * dt;
    e.Position.y += e.Velocity.vy * dt;
  });
}
```

`schema.ts` is the shared vocabulary between systems. Components and archetypes live here so that
every system imports from one place, avoiding circular dependencies. For a small game, a single file
is enough. If it grows past ~100 lines, split by domain:

```text
src/
  schema/
    index.ts          re-exports everything
    components.ts     Position, Velocity, Health, etc.
    tags.ts           Stunned, OnFire, Active, etc.
    archetypes.ts     Enemy, Bullet, Pickup, etc.
```

Systems still import from `"./schema"` (the index re-export), so nothing else changes.

The `update()` function in `main.ts` is the single source of truth for execution order. Reading it
top-to-bottom shows the entire frame. When the order is wrong, there's exactly one place to fix it.
See [Game loop structure](#game-loop-structure) for the full pattern.

## Named archetypes and composition

Declare an archetype as a class when its name should surface in types, editor tooltips, and error
messages — `Storage`, `EntityId`, and `each` views all display the declared name:

```typescript
class Ship extends Archetype([Position, Health], [Frozen]) {}

const ships = register(world, Ship); // Storage<Ship>
const id = spawn(ships); // EntityId<Ship>
```

The class is a declaration, not an object: `new Ship()` is a compile error and throws at runtime.
`register` and `getStorage` accept the class and a plain `archetype(...)` descriptor
interchangeably.

Reuse component lists by spreading — from a shared `as const` set, or from another declared
archetype's `components`/`optionals` statics:

```typescript
const Transform = [Position, Velocity] as const;

class Mover extends Archetype([...Transform]) {}
class Vehicle extends Archetype([...Transform, Health], [Frozen]) {}
class Tank extends Archetype([...Vehicle.components, Cannon], [...Vehicle.optionals]) {}
```

Do not subclass a declared archetype: a class body cannot add components, so
`class Tank extends Vehicle {}` could only alias the same archetype under a second name, and
registration rejects it. Spreads are the composition mechanism.

Archetypes are canonicalized by their component lists: two classes declaring identical lists are the
same archetype and share one storage pool, whatever their names. When two nouns need separate pools,
give each a distinguishing component — a tag is enough.

## Allocation-free event queue

The transient queue pattern for inter-system communication uses dense arrays with a count, the same
strategy as archetype storage: reset `count = 0` and overwrite slots on push. No allocation after
the first frame — the arrays grow once and stay.

```typescript
interface Queue<T> {
  count: number;
  columns: { [K in keyof T]: T[K][] };
}

function createQueue<T extends Record<string, unknown>>(fields: (keyof T)[]): Queue<T> {
  const columns = {} as { [K in keyof T]: T[K][] };
  for (const f of fields) {
    columns[f] = [];
  }
  return { count: 0, columns };
}

function pushQueue<T extends Record<string, unknown>>(q: Queue<T>, value: T): void {
  const i = q.count;
  q.count = i + 1;
  for (const [k, v] of Object.entries(value)) {
    (q.columns[k as keyof T] as unknown[])[i] = v;
  }
}

function drainQueue<T extends Record<string, unknown>>(
  q: Queue<T>,
  fn: (columns: { [K in keyof T]: T[K][] }, i: number) => void,
): void {
  for (let i = q.count - 1; i >= 0; i--) {
    fn(q.columns, i);
  }
  q.count = 0;
}

function clearQueue(q: Queue<unknown>): void {
  q.count = 0;
}
```

Usage:

```typescript
const damageQueue = createQueue<{ targetId: number; amount: number }>(["targetId", "amount"]);

// Producer: combat system records hits
each(projectiles, (e) => {
  const targetId = e.Target.entityId;
  if (targetId !== undefined && alive(enemies, targetId) && checkCollision(e, targetId)) {
    pushQueue(damageQueue, { targetId: targetId as number, amount: e.Damage.value });
    despawn(world, e.id);
  }
});

// Consumer: health system applies damage
drainQueue(damageQueue, (cols, i) => {
  const targetId = cols.targetId[i] as EntityId;
  if (alive(enemies, targetId)) {
    applyDamage(world, targetId, cols.amount[i]);
  }
});

// Second consumer: VFX system (reads before drain, or use separate drain)
// If multiple consumers need the same events, iterate with a plain loop
// instead of drain, then clear manually at end of frame:
for (let i = 0; i < damageQueue.count; i++) {
  spawnHitEffect(world, damageQueue.columns.targetId[i], damageQueue.columns.amount[i]);
}
clearQueue(damageQueue);
```

`drainQueue()` iterates in reverse and resets `count = 0` — the same despawn-safe pattern as
`each()`. For multiple consumers that need the same events, use a plain loop per consumer and
`clearQueue` at end of frame. No allocation occurs after initialization.

## Frame-scoped counter

Track per-frame stats (spawns, kills, damage dealt) without a component. Same allocation-free
principle — a plain number reset each frame.

```typescript
let killsThisFrame = 0;

// Death system
each(enemies, (e) => {
  if (e.Health.hp <= 0) {
    despawn(world, e.id);
    killsThisFrame += 1;
  }
});

// UI system reads it
updateKillCounter(killsThisFrame);

// End of frame
killsThisFrame = 0;
```

Don't put this in a component — it's not entity-scoped. For a more structured approach, use a
resource:

```typescript
const Stats = resource("Stats", { kills: 0 });

// Death system
each(enemies, (e) => {
  if (e.Health.hp <= 0) {
    despawn(world, e.id);
    const stats = getResource(world, Stats);
    stats.kills += 1;
  }
});

// UI system reads it
const stats = getResource(world, Stats);
updateKillCounter(stats.kills);

// End of frame: reset all fields to declared defaults
resetResource(world, Stats);
```

## Deferred despawn list

Sometimes you need to mark entities for removal in one system and despawn them in another (e.g.,
after all systems have had a chance to read the dying entity's data).

```typescript
const despawnList: number[] = [];
let despawnCount = 0;

// Combat system: mark for death but don't despawn yet
each(enemies, (e) => {
  if (e.Health.hp <= 0) {
    despawnList[despawnCount] = e.id as number;
    despawnCount += 1;
  }
});

// VFX system: can still read dying entities' Position, Health, etc.
// ...

// End of frame: flush despawns
for (let i = 0; i < despawnCount; i++) {
  const id = despawnList[i] as EntityId;
  if (alive(enemies, id)) {
    despawn(enemies, id);
  }
}
despawnCount = 0;
```

The `alive()` check guards against double-despawn (entity killed by two systems in the same frame).

## Cooldown timer

A data-carrying optional component for abilities with cooldowns. Enable to start the timer, disable
when it expires.

```typescript
const Cooldown = component("Cooldown", { remaining: 0 });

// Declare as optional on the archetype
class Player extends Archetype([Position, Health], [Cooldown]) {}

// Start cooldown
enable(players, playerId, Cooldown, { remaining: 2.0 });

// Tick cooldowns
each(players, { all: [Cooldown] }, (e) => {
  e.Cooldown.remaining -= dt;
  if (e.Cooldown.remaining <= 0) {
    disable(players, e.id, Cooldown);
  }
});

// Guard ability use
each(players, { none: [Cooldown] }, (e) => {
  if (wantsToFire(e)) {
    fireAbility(e);
    enable(players, e.id, Cooldown, { remaining: 2.0 });
  }
});
```

This uses optional component toggling as a state machine: "has Cooldown" = on cooldown, "no
Cooldown" = ready to fire. No separate timer system needed.

## Game loop structure

Organize a frame as ordered function calls. Call order determines causality — if system A writes
data that system B reads, A must run before B.

```typescript
const Time = resource("Time", { dt: 0, elapsed: 0 });

function inputSystem(world: World): void {
  // read input, write to components
}

function movementSystem(world: World): void {
  const dt = getResource(world, Time).dt;
  query(world, [Position, Velocity], (e) => {
    e.Position.x += e.Velocity.vx * dt;
    e.Position.y += e.Velocity.vy * dt;
  });
}

function combatSystem(world: World): void {
  // damage, status effects
}

function deathSystem(world: World): void {
  // mark dead entities for deferred despawn
}

function cleanupSystem(world: World): void {
  // flush deferred despawns, clear transient queues
}

function update(world: World, dt: number): void {
  setResource(world, Time, { dt });
  inputSystem(world);
  movementSystem(world);
  combatSystem(world);
  deathSystem(world);
  cleanupSystem(world);
}
```

No scheduler, no dependency graph. The developer controls execution order. For a runnable version,
see the examples.

## State machines with archetypes

Use optional tags as exclusive states. One system transitions between states; other systems filter
on the active state.

```typescript
const { Idle, Moving, Attacking } = components({
  Idle: {},
  Moving: {},
  Attacking: {},
});

class Enemy extends Archetype([Position, Health], [Idle, Moving, Attacking]) {}

// Spawn enemies in the Idle state — optional overrides at spawn time
const enemy = spawn(enemies, { Idle: true });

// Transition: disable old state, enable new state
function setState(
  storage: Storage<Enemy>,
  entity: EntityId,
  to: typeof Idle | typeof Moving | typeof Attacking,
): void {
  disable(storage, entity, Idle);
  disable(storage, entity, Moving);
  disable(storage, entity, Attacking);
  enable(storage, entity, to);
}

// AI system: decide next state
each(enemies, { all: [Idle] }, (e) => {
  if (targetInRange(e)) {
    setState(enemies, e.id, Attacking);
  } else if (hasTarget(e)) {
    setState(enemies, e.id, Moving);
  }
});

// Movement system: only move entities in Moving state
each(enemies, { all: [Moving] }, (e) => {
  moveTowardTarget(e);
});

// Combat system: only attack entities in Attacking state
each(enemies, { all: [Attacking] }, (e) => {
  performAttack(e);
  setState(enemies, e.id, Idle);
});
```

ecstatic does not enforce mutual exclusion — the developer must disable the old state before
enabling the new one. The `setState` helper keeps transitions consistent.

## Parent-child without relationships

Store a parent's EntityId in a child component. Cascade operations (despawn, movement) by checking
`alive()` on the stored reference.

```typescript
const { Parent, Offset } = components({
  Parent: { entityId: ref<EntityId>() },
  Offset: { x: 0, y: 0 },
});

class Attachment extends Archetype([Position, Parent, Offset]) {}
const attachments = register(world, Attachment);

// Spawn a child attached to a parent
const parent = spawn(enemies);
spawn(attachments, {
  Parent: { entityId: parent },
  Offset: { x: 0, y: -10 },
});

// Follow system: move children with parent. get() by EntityId is O(1).
each(attachments, (e) => {
  const parentId = e.Parent.entityId;
  if (parentId === undefined || !alive(enemies, parentId)) return;

  e.Position.x = get(enemies, parentId, Position.x) + e.Offset.x;
  e.Position.y = get(enemies, parentId, Position.y) + e.Offset.y;
});

// Cascaded despawn: remove orphaned children
each(attachments, (e) => {
  const parentId = e.Parent.entityId;
  if (parentId === undefined || !alive(enemies, parentId)) {
    despawn(world, e.id);
  }
});
```

The `alive()` check catches stale references when the parent is despawned. This example assumes all
parents are enemies; for parents spread across multiple archetypes, use the world-scoped form
(`get(world, parentId, Position.x)`).

## Collision pair handling

Collect collision pairs into a queue that multiple systems consume. Uses the
[allocation-free event queue](#allocation-free-event-queue) pattern.

```typescript
const collisionQueue = createQueue<{ a: number; b: number }>(["a", "b"]);

// Producer: brute-force pairwise check (replace with spatial partitioning)
each(enemies, (eA) => {
  each(enemies, (eB) => {
    if ((eA.id as number) < (eB.id as number) && overlaps(eA, eB)) {
      pushQueue(collisionQueue, {
        a: eA.id as number,
        b: eB.id as number,
      });
    }
  });
});

// Consumer 1: damage system
for (let i = 0; i < collisionQueue.count; i++) {
  const a = collisionQueue.columns.a[i] as EntityId;
  const b = collisionQueue.columns.b[i] as EntityId;
  if (alive(enemies, a) && alive(enemies, b)) {
    applyCollisionDamage(world, a, b);
  }
}

// Consumer 2: VFX system (reads same pairs)
for (let i = 0; i < collisionQueue.count; i++) {
  spawnImpactEffect(collisionQueue.columns.a[i], collisionQueue.columns.b[i]);
}

// End of frame
clearQueue(collisionQueue);
```

The `i < j` guard avoids duplicate pairs. Each consumer iterates the same queue independently;
`clearQueue` resets the count at end of frame.

## Hoisting query filters

`query()` caches which storages match a filter, keyed by the filter object's **identity**. A filter
written inline is a fresh object on every call, so it misses the cache and re-resolves the whole
archetype set every frame. Hoist it to module scope and the resolution is computed once, then reused
until `register` or `destroyWorld` invalidates it.

```typescript
// Slower: a new array literal each frame, so each frame re-resolves
function movementSystem(world: World, dt: number) {
  query(world, [Position, Velocity], (e) => {
    e.Position.x += e.Velocity.vx * dt;
  });
}

// Faster: one stable filter object, resolved once
const Movable = [Position, Velocity] as const;

function movementSystem(world: World, dt: number) {
  query(world, Movable, (e) => {
    e.Position.x += e.Velocity.vx * dt;
  });
}
```

Both filter forms `query()` accepts — the bare component array and the `{all, any, none}` object —
go through the same identity-keyed cache. Matched-row flags live on the matchers and update as
entities spawn, enable, and disable, so a hoisted filter never goes stale between resolutions.

`each()` and `querySources()` need no hoisting: they resolve a filter to its bitmasks on every call
and dedupe matchers by mask value, so an inline literal costs the literal plus one small tuple and a
short scan of the storage's existing matchers, with no cached archetype set to miss.

## Batch vs single-entity operations

`spawnMany`, `despawnMany`, `enableMany`, and `disableMany` exist for specific cases where bulk
processing is structurally cheaper than N individual calls. They are not universally faster — use
the right form for each situation.

### Use batch when

**Enabling or disabling 2+ optional components on the same entities in one call.**
`enableMany(storage, ids, { Active: true, Slowed: true })` resolves each entity once and applies a
single combined matcher update. Two separate `enable()` calls pay twice the resolve cost and twice
the matcher update. Record values use the same grammar as spawn overrides: `true` = enable (resume),
`false` = skip, `{ field: v }` = enable + patch.

```typescript
// Good: one resolve + one matcher update per entity
enableMany(enemies, ids, { Active: true, Slowed: true });

// More expensive: two resolves + two matcher updates per entity
for (const id of ids) {
  enable(enemies, id, Active);
  enable(enemies, id, Slowed);
}
```

**Operating on all entities (no-ids form).** `enableMany(storage, overrides)` and
`disableMany(storage, comps)` iterate the dense array directly without entity ID resolution. The
single-entity loop must resolve each entity.

```typescript
// Good: iterates dense array directly, no entity resolution
enableMany(enemies, { Active: true });

// More expensive: resolves every entity ID
for (const id of trackedIds) {
  enable(enemies, id, Active);
}
```

**Despawning all entities.** `despawnMany(storage)` (no-ids form) does a single forward pass to
retire all generation slots and calls one bulk column clear. The per-entity loop runs a full
swap-and-pop for every entity.

```typescript
despawnMany(projectiles); // bulk clear — an order of magnitude faster than:
for (const id of ids) {
  // N swap-and-pops
  despawn(projectiles, id);
}
```

**Spawning many entities at once.** `spawnMany(storage, count)` pre-allocates in bulk. Repeated
`spawn()` calls pay per-call overhead individually.

### Use the single-entity form when

**Enabling or disabling a single tag with explicit IDs.** `enable()` and `disable()` are inlined
into tight code with entity resolution and the matcher update already specialized. The batch form's
dispatch overhead does not amortize for a single operation.

**Despawning specific entities by ID.** `despawn(storage, id)` is a single-pass swap-and-pop with no
intermediate allocation. `despawnMany(ids)` must first sort the targeted dense indices, so a plain
`despawn()` loop is faster for partial despawns by ID.

```typescript
// Good: single pass per entity
for (const id of toRemove) {
  despawn(enemies, id);
}

// Slower for partial despawn: sort overhead
despawnMany(enemies, toRemove);
```

**Logic is conditional or interleaved with iteration.** Any `enable`, `disable`, or `despawn` that
depends on per-entity data belongs inside `each()`:

```typescript
each(enemies, (e) => {
  if (e.Health.hp <= 0) {
    despawn(world, e.id);
  }
});
```

## Pooling / recycling

Pre-spawn entities and toggle an `Active` tag instead of spawning and despawning. No allocation in
the hot path after initialization.

```typescript
const Active = component("Active");

class Bullet extends Archetype([Position, Velocity], [Active]) {}
const bullets = register(world, Bullet);

// Freelist of inactive bullet IDs
const pool: number[] = [];
let poolCount = 0;

// Pre-spawn pool
const POOL_SIZE = 200;
for (let i = 0; i < POOL_SIZE; i++) {
  const id = spawn(bullets);
  pool[poolCount] = id as number;
  poolCount += 1;
}

function poolAcquire(): EntityId | undefined {
  if (poolCount === 0) return undefined;
  poolCount -= 1;
  const id = pool[poolCount] as EntityId;
  enable(bullets, id, Active);
  return id;
}

function poolRelease(id: EntityId): void {
  disable(bullets, id, Active);
  pool[poolCount] = id as number;
  poolCount += 1;
}

// Systems only process active bullets
each(bullets, { all: [Active] }, (e) => {
  e.Position.x += e.Velocity.vx * dt;
  if (outOfBounds(e)) {
    poolRelease(e.id);
  }
});
```

When the pool is exhausted, `poolAcquire` returns `undefined` — the caller decides whether to fall
back to a real `spawn()` or skip. The freelist is a dense array with a count, same allocation-free
pattern as the deferred despawn list.

## Entity links vs. relations

A plain `EntityId` field + `alive()` check is the cheapest way to reference another entity. It
covers every forward traversal — child → parent, missile → target, turret → vehicle.

Promote a link to a `relation()` only when you need the **reverse** query: "which entities point
_at_ this one?" A relation maintains a reverse index on every mutation and despawn — strictly more
per-operation work than a plain field. If you never call `querySources`, `getSources`, `hasSources`,
or `countSources`, a plain entity-link is the right tool.

```typescript
// Forward-only: a plain EntityId field is enough. `0 as EntityId` is the perf form
// for a link that's always set at spawn time — pure-scalar column, no nil guard per
// read. If the link can be unset, declare it `ref<EntityId>()` instead so unset reads
// `undefined` rather than a fake ID `0` that passes typechecking into `alive()`.
const { Target } = components({ Target: { entity: 0 as EntityId } });

each(missiles, (e) => {
  const t = e.Target.entity;
  if (!alive(world, t)) {
    despawn(world, e.id);
    return;
  }
  // move toward t...
});

// Need reverse queries? Use a relation instead
const Targets = relation("Targets", [Position]);
// now: querySources(world, Targets, enemyId, ...) finds all missiles targeting that
// enemy
```

See [design/relationships.md](design/relationships.md) for the design rationale.

## Choosing a reverse-query function

Four functions query the reverse map. Pick the cheapest one that answers your question:

| Question                           | Function                               | Cost | Allocates?       |
| ---------------------------------- | -------------------------------------- | ---- | ---------------- |
| "Does anything point at this?"     | `hasSources(world, rel, target)`       | O(A) | No               |
| "How many sources point here?"     | `countSources(world, rel, target)`     | O(S) | No               |
| "Give me the source IDs as a list" | `getSources(world, rel, target, out)`  | O(S) | Only without out |
| "Run logic per source entity"      | `querySources(world, rel, target, fn)` | O(S) | Only with filter |

S = total source count across all archetypes for the (relation, target) pair. A = source archetypes
for the pair. `hasSources` short-circuits on the first source found — O(A) worst case, effectively
O(1) when sources exist.

```typescript
const Targets = relation("Targets", [Position]);

// Threat detection: exit combat when nothing targets us (O(A), zero alloc)
if (!hasSources(world, Targets, entity)) {
  disable(enemies, entity, InCombat);
}

// UI: display attacker count (O(S), zero alloc)
const n = countSources(world, Targets, entity);
drawText(`${n} locked on`);

// Cascade: collect source IDs and despawn them (O(S), allocates once without out)
const sources = getSources(world, Targets, entity);
despawnMany(world, sources);

// Per-source logic: retarget missiles (O(S), zero alloc without filter)
querySources(world, Targets, deadEnemy, (e) => {
  const newTarget = findNearestEnemy(world, e);
  if (newTarget !== undefined) {
    link(world, e.id, Targets, newTarget);
  }
});
```

**Prefer `hasSources` over `countSources(...) > 0`.** `hasSources` short-circuits on the first
source found; `countSources` walks every source. For per-frame polling ("is anyone still targeting
me?"), the difference matters.

## Hot module replacement

ecstatic's declaration functions are idempotent: calling `component()`, `components()`,
`relation()`, or `resource()` a second time with the same name and equal shape returns the existing
registration. A live world's storage stays valid because archetypes resolve to the same descriptors
they used on first registration.

**Systems swap freely.** Systems are plain functions — replace the function reference at module
re-evaluation and the next frame runs the new code. No registration step is involved.

**Schema modules survive re-evaluation when the shape is unchanged.** When Vite (or another
HMR-capable bundler) re-evaluates a module that declares components and resources, each declaration
returns the original descriptor or ID. The world, its archetypes, and all entity data are
unaffected.

**Changing a field's shape throws on re-evaluation.** Adding, removing, or renaming a field, or
changing a default value, width marker, or ref-ness, produces a shape conflict error. The bundler
falls back to a full page reload because existing SoA storage cannot be reinterpreted under the new
layout. The original registrations remain intact after the throw.

**Resource defaults that hold functions or class instances compare by identity.** A re-evaluated
module mints new closures and instances, so the identity check fails and the bundler falls back to a
full reload. Primitive and container defaults (records, arrays, `Date`, `Map`, `Set`) compare by
content and survive re-evaluation.

A minimal `import.meta.hot.accept()` in a systems module is enough to enable HMR for the common case
— schema unchanged, logic updated:

```typescript
// systems/movement.ts
import { each, get, set } from "ecstatic";

export function movement(dt: number) {
  each(ships, (e) => {
    set(ships, e.id, Position, {
      x: e.Position.x + e.Velocity.vx * dt,
      y: e.Position.y + e.Velocity.vy * dt,
    });
  });
}

if (import.meta.hot) {
  import.meta.hot.accept();
}
```

**Surviving a shape change** — keeping the live world across a field rename or a new column —
requires snapshotting the world state before the swap and restoring it by name with defaults filled
in for new fields. This is the snapshot-first serialization module described in the
[design pillars](pillars.md) (see "Consequence for serialization"), not yet implemented.
