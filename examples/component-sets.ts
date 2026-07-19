// Shared component sets and spread archetype declarations.
//
// Demonstrates: reusable const arrays spread into archetype lists, optional
// lists. Composition of sets from other sets.

import {
  archetype,
  components,
  createWorld,
  each,
  get,
  register,
  type Storage,
  set,
  spawn,
} from "ecstatic";

// ---------------------------------------------------------------------------
// Schema — shared component sets
// ---------------------------------------------------------------------------

const { Position, Velocity, Health, Armor, OnFire, Poisoned } = components({
  Position: { x: 0, y: 0 },
  Velocity: { vx: 0, vy: 0 },
  Health: { hp: 100 },
  Armor: { defense: 10 },
  OnFire: {},
  Poisoned: {},
});

const Transform = [Position, Velocity] as const;
const Stats = [Health, Armor] as const;

// Compose sets from other sets.
const Combat = [...Transform, ...Stats] as const;

// Sets work for tags (optionals) too.
const StatusEffects = [OnFire, Poisoned] as const;

// ---------------------------------------------------------------------------
// Archetypes — spread sets into list declarations
// ---------------------------------------------------------------------------

const Vehicle = archetype([...Transform, Health], [...StatusEffects]);
const Panel = archetype([...Transform]);

// Use the composed set directly.
const Boss = archetype([...Combat]);

// ---------------------------------------------------------------------------
// World setup
// ---------------------------------------------------------------------------

const world = createWorld();
const vehicles = register(world, Vehicle);
const panels = register(world, Panel);
const bosses = register(world, Boss);

// ---------------------------------------------------------------------------
// Spawn and access — identical to inline-declared archetypes
// ---------------------------------------------------------------------------

const car = spawn(vehicles, { Position: { x: 10, y: 20 }, Velocity: { vx: 1, vy: 0 } });
const sign = spawn(panels, { Position: { x: 50, y: 0 } });
const dragon = spawn(bosses, { Health: { hp: 500 }, Armor: { defense: 25 } });

// SoA field access works exactly as with inline archetypes.
console.log(`car position: (${get(vehicles, car, Position.x)}, ${get(vehicles, car, Position.y)})`);
console.log(`sign position: (${get(panels, sign, Position.x)}, ${get(panels, sign, Position.y)})`);
console.log(
  `dragon hp: ${get(bosses, dragon, Health.hp)}, armor: ${get(bosses, dragon, Armor.defense)}`,
);

// ---------------------------------------------------------------------------
// Movement system — works across any archetype that spread Transform
// ---------------------------------------------------------------------------

function moveSystem(
  storage: Storage<typeof Vehicle> | Storage<typeof Panel> | Storage<typeof Boss>,
): void {
  each(storage, (e) => {
    e.Position.x = e.Position.x + e.Velocity.vx;
    e.Position.y = e.Position.y + e.Velocity.vy;
  });
}

set(panels, sign, Velocity.vx, 2);

moveSystem(vehicles);
moveSystem(panels);
moveSystem(bosses);

console.log(`car moved to: (${get(vehicles, car, Position.x)}, ${get(vehicles, car, Position.y)})`);
console.log(`sign moved to: (${get(panels, sign, Position.x)}, ${get(panels, sign, Position.y)})`);
