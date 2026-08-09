// World-scoped resource singletons.
//
// Demonstrates: resource(), getResource() (lazy init, mutable reference),
// setResource() (partial merge), resetResource() (restore defaults),
// reference identity.

import {
  archetype,
  components,
  createWorld,
  each,
  getResource,
  register,
  resetResource,
  resource,
  setResource,
  spawn,
} from "ecstatic";

const { Position, Velocity } = components({
  Position: { x: 0, y: 0 },
  Velocity: { vx: 0, vy: 0 },
});

const world = createWorld();
const particles = register(world, archetype([Position, Velocity]));

// ---------------------------------------------------------------------------
// Resource declaration
// ---------------------------------------------------------------------------
// Resources have a separate ID space from components.
// Defaults are copied on first access (lazy init).

const Time = resource("Time", { dt: 0, elapsed: 0, frame: 0 });
const Input = resource("Input", { moveX: 0, moveY: 0, fire: false });

// ---------------------------------------------------------------------------
// Lazy initialization
// ---------------------------------------------------------------------------

const time = getResource(world, Time);
console.log(`initial: dt=${time.dt}, elapsed=${time.elapsed}, frame=${time.frame}`);

// ---------------------------------------------------------------------------
// Partial merge
// ---------------------------------------------------------------------------

const dt = 0.016;
setResource(world, Time, { dt, elapsed: time.elapsed + dt, frame: time.frame + 1 });
console.log(`after setResource: dt=${time.dt}, elapsed=${time.elapsed}, frame=${time.frame}`);

// ---------------------------------------------------------------------------
// Mutable reference
// ---------------------------------------------------------------------------
// getResource() returns the same object every time.
// Direct mutations are visible to all subsequent reads.

time.frame += 1;
time.elapsed += dt;
console.log(`after mutation: elapsed=${time.elapsed}, frame=${time.frame}`);

// ---------------------------------------------------------------------------
// Reset to defaults
// ---------------------------------------------------------------------------
// resetResource() restores all fields to their declared defaults.
// Unlike setResource()'s partial merge, it resets every field at once.

resetResource(world, Time);
console.log(`after reset: dt=${time.dt}, elapsed=${time.elapsed}, frame=${time.frame}`);

// ---------------------------------------------------------------------------
// Same reference
// ---------------------------------------------------------------------------

const time2 = getResource(world, Time);
console.log(`\nsame reference: ${time === time2}`);

// ---------------------------------------------------------------------------
// Typical usage: frame time in a movement system
// ---------------------------------------------------------------------------

spawn(particles, { Velocity: { vx: 100, vy: 50 } });
spawn(particles, { Velocity: { vx: -30, vy: 80 } });

console.log("\n=== Movement system using Time + Input resources ===");
const t = getResource(world, Time);
const input = getResource(world, Input);

setResource(world, Time, { dt: 0.016 });
setResource(world, Input, { moveX: 1, fire: true });

each(particles, (e) => {
  e.Position.x += (e.Velocity.vx + input.moveX) * t.dt;
  e.Position.y += (e.Velocity.vy + input.moveY) * t.dt;
  console.log(`  particle ${e.id}: (${e.Position.x}, ${e.Position.y})`);
});
console.log(`fire pressed: ${input.fire}`);
