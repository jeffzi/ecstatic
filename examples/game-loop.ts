// System ordering and inter-system communication.
//
// Demonstrates: structuring a game frame as ordered system calls, shared mutable
// state, optional flags as signals, resources for frame-global data, deferred
// despawn list. Patterns from docs/events.md applied in a complete frame.

import {
  alive,
  archetype,
  components,
  createWorld,
  despawn,
  each,
  enable,
  type EntityId,
  getResource,
  register,
  resetResource,
  resource,
  setResource,
  spawn,
} from "ecstatic";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const { Position, Velocity, Health, OnFire } = components({
  Position: { x: 0, y: 0 },
  Velocity: { vx: 0, vy: 0 },
  Health: { hp: 100, maxHp: 100 },
  OnFire: {},
});

const EnemyArch = archetype([Position, Velocity, Health], [OnFire]);

const world = createWorld();
const enemies = register(world, EnemyArch);

const Time = resource("Time", { dt: 0, frame: 0 });
const FrameStats = resource("FrameStats", { damageDealt: 0 });

// ---------------------------------------------------------------------------
// Systems
// ---------------------------------------------------------------------------
// Each system is a plain function. Order determines causality:
// movement → burn → death_mark → cleanup

function movementSystem(): void {
  const dt = getResource(world, Time).dt;
  each(enemies, (e) => {
    e.Position.x += e.Velocity.vx * dt;
    e.Position.y += e.Velocity.vy * dt;
  });
}

function burnSystem(): void {
  const stats = getResource(world, FrameStats);
  each(enemies, { all: [OnFire] }, (e) => {
    e.Health.hp -= 10;
    stats.damageDealt += 10;
  });
}

// Deferred despawn list: collect entity IDs during iteration, flush at end of
// frame. Dense array + count — allocation-free after the first frame.
const despawnList: EntityId[] = [];
let despawnCount = 0;

function deathSystem(): void {
  each(enemies, (e) => {
    if (e.Health.hp <= 0) {
      despawnList[despawnCount] = e.id;
      despawnCount += 1;
    }
  });
}

function cleanupSystem(): void {
  for (let i = 0; i < despawnCount; i++) {
    const id = despawnList[i]!;
    if (alive(world, id)) {
      despawn(world, id);
    }
  }
  despawnCount = 0;
}

// ---------------------------------------------------------------------------
// Frame update
// ---------------------------------------------------------------------------
// Systems run in explicit order. No scheduler, no dependency graph.

function update(dt: number, frame: number): void {
  setResource(world, Time, { dt, frame });
  resetResource(world, FrameStats);

  movementSystem();
  burnSystem();
  deathSystem();
  cleanupSystem();
}

// ---------------------------------------------------------------------------
// Simulation
// ---------------------------------------------------------------------------

console.log("=== Game loop: 5 frames ===\n");

const burning = spawn(enemies, { Health: { hp: 25 }, Velocity: { vx: 10 } });
enable(enemies, burning, OnFire);

spawn(enemies, { Velocity: { vx: -5 } });

for (let frame = 1; frame <= 5; frame++) {
  update(0.016, frame);

  const t = getResource(world, Time);
  const fs = getResource(world, FrameStats);
  console.log(`frame ${t.frame}: ${enemies.n} enemies alive, damage=${fs.damageDealt}`);
  each(enemies, (e) => {
    console.log(`  [${e.id}] pos=(${e.Position.x}, ${e.Position.y}) hp=${e.Health.hp}`);
  });
}
