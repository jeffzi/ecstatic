// Iteration over archetype storages.
//
// Demonstrates: each() with view callbacks, despawnMany().

import { Archetype, components, createWorld, despawnMany, each, register, spawn } from "ecstatic";

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

spawn(enemies, { Position: { x: 5, y: 10 } });
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
// despawnMany() — bulk remove
// ---------------------------------------------------------------------------

console.log("\n=== despawnMany(bullets) ===");
despawnMany(bullets);
console.log(`bullets remaining: ${bullets.n}`);
console.log(`enemies unchanged: ${enemies.n}`);
