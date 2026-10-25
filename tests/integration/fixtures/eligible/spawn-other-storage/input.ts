import { archetype, component, createWorld, each, get, register, spawn, spawnMany } from "ecstatic";

const Cell = component("HiveCell", { x: 0 });
const Bee = component("HiveBee", { y: 0 });

/**
 * Spawns from the body into a truthfully typed storage of another shape, which leaves the iterated storage's columns
 * in place: every write lands in the iterated storage and every spawned row in the other. Each spawn's target is
 * evaluated once, after the code before the call and before the call's other arguments.
 *
 * @returns Each original row's `x`, how many rows the other storage holds, and the order the body's parts ran in.
 */
export function scenario(): unknown {
  const world = createWorld();
  const cells = register(world, archetype([Cell]));
  const bees = register(world, archetype([Bee]));
  const ids = [spawn(cells, { HiveCell: { x: 1 } }), spawn(cells, { HiveCell: { x: 2 } })];
  let trace = "";

  each(cells, (e) => {
    trace += "b";
    spawn(((trace += "t"), bees), ((trace += "v"), { HiveBee: { y: e.HiveCell.x } }));
    e.HiveCell.x += 10;
  });
  each(cells, (e) => {
    trace += "B";
    spawnMany(((trace += "T"), bees), ((trace += "N"), 2));
    e.HiveCell.x += 100;
  });

  return { xs: ids.map((id) => get(cells, id, Cell.x)), bees: bees.n, trace };
}
