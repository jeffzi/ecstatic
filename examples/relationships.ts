// Forward-only entity references via plain component fields.
//
// Demonstrates: ref() fields storing entity IDs, liveness checks with
// alive(), and despawn() during iteration.

import {
  alive,
  archetype,
  components,
  createWorld,
  despawn,
  type EntityId,
  each,
  get,
  ref,
  register,
  spawn,
} from "ecstatic";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const { Position, Health } = components({
  Position: { x: 0, y: 0 },
  Health: { hp: 100 },
});

// Plain components — forward-only references, no reverse index.
const { Target } = components({ Target: { entity: ref<EntityId>() } });

// ---------------------------------------------------------------------------
// Archetypes & world setup
// ---------------------------------------------------------------------------

const Ship = archetype([Position, Health]);
const Projectile = archetype([Position, Target]);

const world = createWorld();
const ships = register(world, Ship);
const projectiles = register(world, Projectile);

// ---------------------------------------------------------------------------
// Forward-only targeting (plain entity-link)
// ---------------------------------------------------------------------------
// A homing projectile only asks "who am I targeting?" — never "who targets me?".
// With no reverse query, a plain component field is all it needs.

console.log("=== Forward-only targeting ===");

const targetShip = spawn(ships);
spawn(projectiles, { Target: { entity: targetShip } });

// Read the stored id, check liveness, steer or self-destruct.
function steerProjectiles(): void {
  each(projectiles, (e) => {
    const tid = get(projectiles, e.id, Target.entity);
    if (tid !== undefined && alive(world, tid)) {
      console.log(`  projectile ${e.id}: target ${tid} alive — tracking`);
    } else {
      console.log(`  projectile ${e.id}: target dead — self-destruct`);
      despawn(world, e.id);
    }
  });
}

steerProjectiles();
despawn(world, targetShip); // kill the target, then re-run the same pass
steerProjectiles();
