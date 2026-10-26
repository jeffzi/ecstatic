// rewrite-applies: mode-realloc-safe
// rewrite-applies: filter-masked
// rewrite-applies: filter-element-guard
import {
  archetype,
  component,
  createWorld,
  disable,
  each,
  enable,
  register,
  spawn,
  spawnMany,
} from "ecstatic";

const Spot = component("FlockSpot", { x: 0 });
const Shield = component("FlockShield");
const Flock = archetype([Spot], [Shield]);

/**
 * Visits, from the last row to the first, exactly the rows a literal filter's matcher flags when the loop reaches
 * them, in bodies that compile realloc-safe: one whose helper enables and disables rows not yet visited, and one
 * that spawns into the iterated storage past its capacity, which replaces the matcher's flags, before disabling a
 * row not yet visited. The spawned rows are never visited.
 *
 * @returns The rows each call visited, in visit order, how many rows the storage holds, and how many matchers.
 */
export function scenario(): unknown {
  const storage = register(createWorld(), Flock);
  const first = spawn(storage, { FlockSpot: { x: 1 }, FlockShield: true });
  const second = spawn(storage, { FlockSpot: { x: 2 } });
  const third = spawn(storage, { FlockSpot: { x: 3 }, FlockShield: true });
  spawn(storage, { FlockSpot: { x: 4 } });
  spawn(storage, { FlockSpot: { x: 5 }, FlockShield: true });
  const seen: unknown[] = [];
  const toggle = (): void => {
    disable(storage, third, Shield);
    enable(storage, second, Shield);
  };

  seen.push("toggled");
  each(storage, [Shield], (e) => {
    seen.push(e.FlockSpot.x);
    if (e.FlockSpot.x === 5) toggle();
  });
  seen.push("grown");
  each(storage, [Shield], (e) => {
    seen.push(e.FlockSpot.x);
    if (e.FlockSpot.x === 5) {
      spawnMany(storage, 100, { FlockShield: true });
      disable(storage, first, Shield);
    }
  });

  return { seen, rows: storage.n, matchers: storage.matchers.length };
}
