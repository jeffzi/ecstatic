// rewrite-applies: mode-realloc-safe
// rewrite-applies: write-required-field
// rewrite-applies: write-optional-field
// rewrite-applies: write-boolean-field
// rewrite-applies: update-field
import {
  archetype,
  component,
  createWorld,
  each,
  get,
  has,
  register,
  spawn,
  spawnMany,
} from "ecstatic";

const Spot = component("SwarmSpot", { x: 0, y: 0 });
const Wing = component("SwarmWing", { beat: false });
const Sting = component("SwarmSting", { hp: 0 });

/**
 * Spawns into the iterated storage past its capacity, which replaces its columns: directly in the body, and inside
 * the right-hand side of plain, compound, and logical field writes, optional and boolean fields included. Every
 * write lands in the columns growth put in place, and the spawned rows are never visited.
 *
 * @returns The rows visited, each original row's fields after the loop, and how many rows the storage holds.
 */
export function scenario(): unknown {
  const storage = register(createWorld(), archetype([Spot, Wing], [Sting]));
  const ids = [
    spawn(storage, { SwarmSpot: { x: 1, y: 0 }, SwarmSting: { hp: 2 } }),
    spawn(storage, { SwarmSpot: { x: 2, y: 0 } }),
  ];
  const visited: number[] = [];
  const grow = (value: number): number => {
    spawnMany(storage, 20);
    return value;
  };

  each(storage, (e) => {
    visited.push(ids.indexOf(e.id));
    e.SwarmSpot.x = grow(e.SwarmSpot.x * 10);
    e.SwarmSpot.x += grow(5);
    e.SwarmSpot.y ||= grow(e.SwarmSpot.x + 1);
    e.SwarmWing.beat ||= grow(1) > 0;
    // oxlint-disable-next-line typescript/strict-boolean-expressions -- testing an optional slot is the lowering under test
    if (e.SwarmSting) e.SwarmSting.hp += grow(3);
    grow(0);
    e.SwarmSpot.y++;
  });

  return {
    visited,
    fields: ids.map((id) => [
      get(storage, id, Spot.x),
      get(storage, id, Spot.y),
      get(storage, id, Wing.beat),
      has(storage, id, Sting) ? get(storage, id, Sting.hp) : -1,
    ]),
    rows: storage.n,
  };
}
