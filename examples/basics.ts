// Schema definition and entity lifecycle.
//
// Demonstrates: components(), createWorld(), register(),
// spawn(), despawn(), alive(), generational ID reuse.

import {
  alive,
  archetype,
  components,
  createWorld,
  despawn,
  each,
  get,
  register,
  spawn,
} from "ecstatic";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const { Position, Health, Stunned, OnFire } = components({
  // Data-carrying components: fields become parallel arrays in the archetype.
  Position: { x: 0, y: 0 },
  Health: { hp: 100, maxHp: 100 },

  // Tags: 0-field boolean flags. No SoA storage, just a bitmask bit.
  Stunned: {},
  OnFire: {},
});

// Archetype: fixed entity layout. Required components are always present;
// optional components (second list) can be toggled per-entity at runtime.
const Enemy = archetype([Position, Health], [Stunned, OnFire]);

// ---------------------------------------------------------------------------
// World setup
// ---------------------------------------------------------------------------

const world = createWorld();
const enemies = register(world, Enemy);

// ---------------------------------------------------------------------------
// Spawn
// ---------------------------------------------------------------------------

const e1 = spawn(enemies);
console.log(`e1 alive: ${alive(enemies, e1)}`);

// Access via get()
console.log(`e1 pos: (${get(enemies, e1, Position.x)}, ${get(enemies, e1, Position.y)})`);
console.log(`e1 hp:  ${get(enemies, e1, Health.hp)}/${get(enemies, e1, Health.maxHp)}`);

// Spawn with overrides (required components only)
const e2 = spawn(enemies, { Position: { x: 10, y: 20 }, Health: { hp: 50 } });
console.log(`\nenemy count: ${enemies.n}`);

// Read SoA data via each() — the safe way to access entity data.
// The callback receives a view for safe field access.
each(enemies, (e) => {
  console.log(`  enemy ${e.id}: pos=(${e.Position.x}, ${e.Position.y}) hp=${e.Health.hp}`);
});

// ---------------------------------------------------------------------------
// Despawn and generational IDs
// ---------------------------------------------------------------------------

despawn(enemies, e1);
console.log("\nafter despawn e1:");
console.log(`e1 alive: ${alive(enemies, e1)}`); // false — generation mismatch
console.log(`e2 alive: ${alive(enemies, e2)}`); // true
console.log(`enemy count: ${enemies.n}`);

// Spawning reuses the freed index (LIFO freelist), but with a new generation.
const e3 = spawn(enemies);
console.log("\nafter respawn into freed slot:");
console.log(`e1 (stale) alive: ${alive(enemies, e1)}`); // false — old generation
console.log(`e3 alive: ${alive(enemies, e3)}`); // true — new generation, same index
console.log(`enemy count: ${enemies.n}`);
