// Optional components, tags, and filtered iteration.
//
// Demonstrates: spawn-time optional overrides (true/false/Partial<Fields>),
// enable()/disable() for tags and data-carrying optionals, enable() with field
// overrides, has()/hasAny(), filtered each() with all/any/none, despawn during
// filtered iteration, cooldown timer pattern.

import {
  alive,
  Archetype,
  components,
  createWorld,
  despawn,
  despawnMany,
  disable,
  each,
  enable,
  get,
  has,
  hasAny,
  register,
  spawn,
  spawnMany,
} from "ecstatic";

const { Position, Health, Shield, Cooldown, Stunned, OnFire } = components({
  Position: { x: 0, y: 0 },
  Health: { hp: 100, maxHp: 100 },
  Shield: { hp: 50, defense: 10 },
  Cooldown: { remaining: 0 },
  Stunned: {},
  OnFire: {},
});

class Enemy extends Archetype([Position, Health], [Stunned, OnFire, Shield, Cooldown]) {}

const world = createWorld();
const enemies = register(world, Enemy);

const e1 = spawn(enemies);
const e2 = spawn(enemies);
const e3 = spawn(enemies);

// ---------------------------------------------------------------------------
// Spawn-time optional overrides
// ---------------------------------------------------------------------------
// Pass optional component keys alongside required ones in the overrides arg.
// true  — enable with defaults
// false — stay disabled (same as omitting; useful when building overrides dynamically)
// { field: value, ... } — enable and override specific fields

const eShielded = spawn(enemies, {
  Position: { x: 10, y: 5 },
  Shield: { hp: 200, defense: 20 },
  Stunned: true,
});
console.log("\n=== spawn-time optional overrides ===");
console.log(`eShielded has Shield: ${has(enemies, eShielded, Shield)}`);
console.log(`eShielded shield hp: ${get(enemies, eShielded, Shield.hp)}`);
console.log(`eShielded stunned: ${has(enemies, eShielded, Stunned)}`);

// Batch spawn: all entities get the same optional state at creation
const shieldedIds = spawnMany(enemies, 3, { Shield: true, OnFire: true });
console.log(`\nspawned ${shieldedIds.length} entities with Shield+OnFire enabled`);
const firstShielded = shieldedIds[0];
if (firstShielded != null) {
  console.log(`first has Shield: ${has(enemies, firstShielded, Shield)}`);
  console.log(`first shield hp (defaults): ${get(enemies, firstShielded, Shield.hp)}`);
}

despawn(enemies, eShielded);
despawnMany(enemies, shieldedIds);

// ---------------------------------------------------------------------------
// Enable/disable tags
// ---------------------------------------------------------------------------

enable(enemies, e1, OnFire);
enable(enemies, e2, Stunned);
enable(enemies, e2, OnFire);

console.log("=== has() checks ===");
console.log(`e1 on fire: ${has(enemies, e1, OnFire)}`);
console.log(`e2 stunned AND on fire: ${has(enemies, e2, [Stunned, OnFire])}`);
console.log(`e1 has any status: ${hasAny(enemies, e1, [Stunned, OnFire])}`);

// ---------------------------------------------------------------------------
// Enable data-carrying optional with field overrides
// ---------------------------------------------------------------------------

enable(enemies, e1, Shield, { hp: 75, defense: 15 });
console.log(`\ne1 shield hp: ${get(enemies, e1, Shield.hp)}`);

// Record form: enable multiple optionals at once
enable(enemies, e3, { OnFire: true, Shield: { hp: 30 } });

// ---------------------------------------------------------------------------
// Filtered iteration
// ---------------------------------------------------------------------------
// { all: [X] } — only entities where X is enabled
// { none: [X] } — only entities where X is NOT enabled
// { any: [X, Y] } — entities where at least one of X, Y is enabled

console.log("\n=== Burn damage (all: [OnFire]) ===");
each(enemies, { all: [OnFire] }, (e) => {
  e.Health.hp -= 5;
  console.log(`  enemy ${e.id}: hp=${e.Health.hp}`);
});

console.log("\n=== Heal non-burning (none: [OnFire]) ===");
each(enemies, { none: [OnFire] }, (e) => {
  e.Health.hp = e.Health.maxHp;
  console.log(`  enemy ${e.id}: hp=${e.Health.hp}`);
});

// Combined filter: on fire but not stunned
console.log("\n=== On fire but not stunned (all: [OnFire], none: [Stunned]) ===");
each(enemies, { all: [OnFire], none: [Stunned] }, (e) => {
  console.log(`  enemy ${e.id}: hp=${e.Health.hp}`);
});

// ---------------------------------------------------------------------------
// Disable
// ---------------------------------------------------------------------------

disable(enemies, e2, Stunned);
console.log(`\ne2 still stunned? ${has(enemies, e2, Stunned)}`);

// ---------------------------------------------------------------------------
// Despawn during filtered iteration
// ---------------------------------------------------------------------------
// Safe: each() iterates in reverse (n-1 to 0), so swap-and-pop only moves
// the last element into the current slot — no entity is skipped.

console.log("\n=== Despawn all burning enemies ===");
each(enemies, { all: [OnFire] }, (e) => {
  despawn(enemies, e.id);
});
console.log(`enemies remaining: ${enemies.n}`);
console.log(`e1 alive: ${alive(enemies, e1)}`);

// ---------------------------------------------------------------------------
// Cooldown timer pattern
// ---------------------------------------------------------------------------
// A data-carrying optional as a state machine:
// "has Cooldown" = on cooldown, "no Cooldown" = ready to fire.

const e4 = spawn(enemies);
enable(enemies, e4, Cooldown, { remaining: 3 });

console.log("\n=== Cooldown timer ===");
const dt = 1;
for (let frame = 1; frame <= 4; frame++) {
  each(enemies, { all: [Cooldown] }, (e) => {
    e.Cooldown.remaining -= dt;
    console.log(`  frame ${frame}: cooldown=${e.Cooldown.remaining}`);
  });

  if (has(enemies, e4, Cooldown) && get(enemies, e4, Cooldown.remaining) <= 0) {
    disable(enemies, e4, Cooldown);
    console.log("  cooldown expired — ready to fire");
  }
}
