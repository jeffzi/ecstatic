// Iteration and cross-archetype queries.
//
// Demonstrates: each() single/multi-archetype, query() shorthand and filtered,
// despawnMany(), view callbacks.

import {
  Archetype,
  components,
  createWorld,
  despawnMany,
  each,
  enable,
  query,
  register,
  spawn,
} from "ecstatic";

const { Position, Velocity, Health, OnFire } = components({
  Position: { x: 0, y: 0 },
  Velocity: { vx: 0, vy: 0 },
  Health: { hp: 100, maxHp: 100 },
  OnFire: {},
});

class Enemy extends Archetype([Position, Health], [OnFire]) {}
class Bullet extends Archetype([Position, Velocity]) {}

const world = createWorld();
const enemies = register(world, Enemy);
const bullets = register(world, Bullet);

const goblin = spawn(enemies, { Position: { x: 5, y: 10 } });
spawn(enemies, { Position: { x: 20, y: 30 } });
spawn(bullets, { Velocity: { vx: 1, vy: 0 } });
spawn(bullets, { Velocity: { vx: 0, vy: 1 } });

// ---------------------------------------------------------------------------
// each() — single archetype
// ---------------------------------------------------------------------------
// Callback receives a view with safe field access.

console.log("=== Single archetype: move bullets ===");
each(bullets, (e) => {
  e.Position.x += e.Velocity.vx;
  e.Position.y += e.Velocity.vy;
  console.log(`  bullet ${e.id}: (${e.Position.x}, ${e.Position.y})`);
});

// ---------------------------------------------------------------------------
// each() — multi-archetype
// ---------------------------------------------------------------------------
// Pass an array of storages to iterate all entities across them.
// The view is typed as the union of listed storages — shared components
// are accessible directly.

console.log("\n=== each (multi-storage): all entities with Position ===");
each([enemies, bullets], (e) => {
  console.log(`  entity ${e.id}: (${e.Position.x}, ${e.Position.y})`);
});

// ---------------------------------------------------------------------------
// query() — cross-archetype by component
// ---------------------------------------------------------------------------
// Discovers all registered archetypes that have the requested components.
// Hoist the component array to benefit from the resolution cache; a fresh
// literal re-resolves every call.

const positionQuery = [Position] as const;
console.log("\n=== query([Position]): all entities with Position ===");
let posCount = 0;
query(world, positionQuery, (e) => {
  console.log(`  pos: (${e.Position.x}, ${e.Position.y})`);
  posCount += 1;
});
console.log(`  total: ${posCount}`);

// ---------------------------------------------------------------------------
// query() — filtered
// ---------------------------------------------------------------------------
// { all: [...], any: [...], none: [...] }
// all = required on archetype AND enabled. any = at least one. none = excluded.

enable(enemies, goblin, OnFire);

console.log("\n=== query({ all: [Position], none: [OnFire] }) ===");
query(world, { all: [Position], none: [OnFire] }, (e) => {
  console.log(`  pos: (${e.Position.x}, ${e.Position.y})`);
});

// ---------------------------------------------------------------------------
// despawnMany() — bulk remove
// ---------------------------------------------------------------------------

console.log("\n=== despawnMany(bullets) ===");
despawnMany(bullets);
console.log(`bullets remaining: ${bullets.n}`);
console.log(`enemies unchanged: ${enemies.n}`);
