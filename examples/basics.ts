// Schema definition and entity lifecycle.
//
// Demonstrates: components(), createWorld(), register(),
// spawn(), despawn(), alive(), generational ID reuse,
// i32 width markers, string fields.

import {
  alive,
  archetype,
  components,
  createWorld,
  despawn,
  each,
  get,
  i32,
  register,
  spawn,
} from "ecstatic";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const { Position, Health, Label, Stunned, OnFire } = components({
  // Data-carrying components: fields become parallel arrays in the archetype.
  Position: { x: 0, y: 0 },

  // Width markers select the TypedArray backing for numeric fields.
  // i32() → Int32Array (4 bytes) instead of the default Float64Array (8 bytes).
  Health: { hp: i32(100), maxHp: i32(100) },

  // String fields use a plain string as the default value.
  Label: { name: "" },

  // Tags: 0-field boolean flags. No SoA storage, just a bitmask bit.
  Stunned: {},
  OnFire: {},
});

// Archetype: fixed entity layout. Required components are always present;
// optional components (second list) can be toggled per-entity at runtime.
const Enemy = archetype([Position, Health, Label], [Stunned, OnFire]);

// ---------------------------------------------------------------------------
// World setup
// ---------------------------------------------------------------------------

const world = createWorld();
const enemies = register(world, Enemy);

// ---------------------------------------------------------------------------
// Spawn
// ---------------------------------------------------------------------------

const e1 = spawn(enemies, { Label: { name: "Goblin" } });
console.log(`e1 alive: ${alive(enemies, e1)}`);

// Access via get()
console.log(`e1 pos: (${get(enemies, e1, Position.x)}, ${get(enemies, e1, Position.y)})`);
console.log(`e1 hp:  ${get(enemies, e1, Health.hp)}/${get(enemies, e1, Health.maxHp)}`);
console.log(`e1 name: ${get(enemies, e1, Label.name)}`);

// Spawn with overrides (required components only)
const e2 = spawn(enemies, {
  Position: { x: 10, y: 20 },
  Health: { hp: 50 },
  Label: { name: "Orc" },
});
console.log(`\nenemy count: ${enemies.n}`);

// Read SoA data via each() — the safe way to access entity data.
// The callback receives a view for safe field access.
each(enemies, (e) => {
  console.log(
    `  enemy ${e.id}: name=${e.Label.name} pos=(${e.Position.x}, ${e.Position.y}) hp=${e.Health.hp}`,
  );
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
