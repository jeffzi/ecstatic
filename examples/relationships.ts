// Relationship patterns: plain entity-links vs relation() reverse indexing.
//
// Demonstrates: relation() (pure, constrained, data-only), link()/unlink(),
// getTarget(), get(s, id, Rel.target), getSources(), querySources(),
// despawnMany(world) / despawnMany(world, ids), and when to promote a
// forward-only reference to a reverse-indexed relation.

import {
  alive,
  archetype,
  components,
  createWorld,
  despawn,
  despawnMany,
  each,
  type EntityId,
  get,
  getSources,
  getTarget,
  link,
  querySources,
  ref,
  register,
  relation,
  spawn,
  unlink,
} from "ecstatic";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const { Position, Health, Affiliation } = components({
  Position: { x: 0, y: 0 },
  Health: { hp: 100 },
  Affiliation: { teamId: 0 },
});

// Plain components — forward-only references, no reverse index.
const { Target } = components({ Target: { entity: ref<EntityId>() } });

// Relations — reverse-indexed; use only when you querySources / getSources.
const ChildOf = relation("ChildOf", [Position], { offsetX: 0, offsetY: 0 });
const ContainedIn = relation("ContainedIn");
const MemberOf = relation("MemberOf");
const Aggro = relation("Aggro", { threat: 0 });

// ---------------------------------------------------------------------------
// Archetypes & world setup
// ---------------------------------------------------------------------------

const Ship = archetype([Position, Health]);
const Turret = archetype([Position, ChildOf]);
const Projectile = archetype([Position, Target]);
const Item = archetype([Position], [ContainedIn]);
const Bag = archetype([Position]);
const PlayerA = archetype([Position, Affiliation]);
const Team = archetype([Position]);
const PlayerB = archetype([Position, MemberOf]);
const Enemy = archetype([Position, Health, Aggro]);

const world = createWorld();
const ships = register(world, Ship);
const turrets = register(world, Turret);
const projectiles = register(world, Projectile);
const items = register(world, Item);
const bags = register(world, Bag);
const playersA = register(world, PlayerA);
const teams = register(world, Team);
const playersB = register(world, PlayerB);
const enemies = register(world, Enemy);

// ---------------------------------------------------------------------------
// 1. Forward-only targeting (plain entity-link)
// ---------------------------------------------------------------------------
// A homing projectile only asks "who am I targeting?" — never "who targets me?".
// With no reverse query, a plain component field is cheaper than a relation.

console.log("\n=== 1. Forward-only targeting ===");

const targetShip = spawn(ships);
spawn(projectiles, { Target: { entity: targetShip } });

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
despawn(world, targetShip);
steerProjectiles();

// ---------------------------------------------------------------------------
// 2. Parent-child with cascade (relation + querySources)
// ---------------------------------------------------------------------------
// ChildOf is constrained to [Position] — linking to an entity without Position
// is a compile error. The reverse index powers cascade despawn.

console.log("\n=== 2. Parent-child with cascade ===");

const vehicle = spawn(ships);
const turretL = spawn(turrets, { ChildOf: { target: vehicle, offsetX: -10, offsetY: 0 } });
spawn(turrets, { ChildOf: { target: vehicle, offsetX: 10, offsetY: 5 } });

console.log(`  turretL parent === vehicle: ${getTarget(world, turretL, ChildOf) === vehicle}`);
console.log("  vehicle children:");
querySources(world, ChildOf, vehicle, (e) => {
  console.log(`    child ${e.id}`);
});

// Cascade recipe: capture children, despawn the parent first (drops the reverse
// bucket in one shot), then bulk-despawn the captured children.
const children = getSources(world, ChildOf, vehicle);
despawn(world, vehicle);
despawnMany(world, children);
console.log(`  turretL alive after cascade: ${alive(world, turretL)}`);

// ---------------------------------------------------------------------------
// 3. Inventory (optional relation + link / unlink)
// ---------------------------------------------------------------------------
// ContainedIn is optional — an item can exist with no container (on the ground).
// Each item is the source pointing at its bag; querySources recovers contents.

console.log("\n=== 3. Inventory ===");

const bag = spawn(bags);
const sword = spawn(items);
const shield = spawn(items);
const potion = spawn(items);

link(world, sword, ContainedIn, bag);
link(world, shield, ContainedIn, bag);
link(world, potion, ContainedIn, bag);

console.log("  bag contents:");
querySources(world, ContainedIn, bag, (e) => {
  console.log(`    item ${e.id}`);
});

unlink(world, shield, ContainedIn);
console.log("  after dropping shield:");
querySources(world, ContainedIn, bag, (e) => {
  console.log(`    item ${e.id}`);
});

// ---------------------------------------------------------------------------
// 4. Team membership: pattern choice
// ---------------------------------------------------------------------------
// Same data, two layouts. Pick the cheapest that covers your access pattern.

console.log("\n=== 4. Team membership: pattern choice ===");

const TEAM_RED = 1;
const TEAM_BLUE = 2;

// Approach A: forward-only scalar. Cheap, but "all members of a team" is O(n).
const alice = spawn(playersA, { Affiliation: { teamId: TEAM_RED } });
spawn(playersA, { Affiliation: { teamId: TEAM_BLUE } });
spawn(playersA, { Affiliation: { teamId: TEAM_RED } });
console.log(`  A: alice team = ${get(playersA, alice, Affiliation.teamId)}`);

let redCount = 0;
each(playersA, (e) => {
  if (e.Affiliation.teamId === TEAM_RED) redCount += 1;
});
console.log(`  A: red members (full scan) = ${redCount}`);

// Approach B: reverse-indexed relation. "All members of team X" is O(members).
const teamRed = spawn(teams);
const teamBlue = spawn(teams);
const aliceB = spawn(playersB, { MemberOf: { target: teamRed } });
spawn(playersB, { MemberOf: { target: teamBlue } });
const carolB = spawn(playersB, { MemberOf: { target: teamRed } });
console.log(`  B: aliceB team = ${getTarget(world, aliceB, MemberOf)}`);

let redBCount = 0;
querySources(world, MemberOf, teamRed, () => {
  redBCount += 1;
});
console.log(`  B: red members (indexed) = ${redBCount}`);

// link() overwrites the previous target — reassigning a team is one call.
link(world, carolB, MemberOf, teamBlue);
console.log(`  B: carolB moved to ${getTarget(world, carolB, MemberOf)} (blue=${teamBlue})`);

console.log("  → forward-only is cheapest; promote to relation() only when you reverse-query.");

// ---------------------------------------------------------------------------
// 5. Data-only relation + bulk teardown
// ---------------------------------------------------------------------------
// relation(name, defaults) carries data with no constraints. get(s, id, Rel.target)
// reads the raw stored id — no liveness check, for hot-path iteration.

console.log("\n=== 5. Data-only relation + bulk teardown ===");

const hero = spawn(ships);
const goblin = spawn(enemies, { Aggro: { target: hero, threat: 50 } });
spawn(enemies, { Aggro: { target: hero, threat: 80 } });

console.log(
  `  goblin → target ${get(enemies, goblin, Aggro.target)}, threat ${get(enemies, goblin, Aggro.threat)}`,
);

console.log(`  entities targeting hero: ${getSources(world, Aggro, hero).length}`);

// despawnMany(world) clears every entity at once (vs the ids-list form in §2).
despawnMany(world);
console.log(`  hero alive after world clear: ${alive(world, hero)}`);
