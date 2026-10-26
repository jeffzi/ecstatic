// rewrite-applies: filter-runtime
// rewrite-applies: filter-runtime-mixed
import { archetype, component, createWorld, each, register, spawn, type Storage } from "ecstatic";

const Spot = component("LatchSpot", { x: 0 });
const Bolt = component("LatchBolt");
const Latch = archetype([Spot], [Bolt]);

/**
 * Records the rows one call site visits for a filter typed `object`, which a component array satisfies
 * as well as a filter object.
 *
 * @param storage - The storage of the scenario, iterated through one call site.
 * @param filter - A component array or a filter object.
 * @returns The `x` of each visited row, in visit order.
 */
function visit(storage: Storage<typeof Latch>, filter: object): number[] {
  const seen: number[] = [];
  each(storage, filter, (e) => {
    seen.push(e.LatchSpot.x);
  });
  return seen;
}

/**
 * Filters one call site by a value typed `object`: an array acts as its `all` axis, skipping the rows
 * without its components, and an object as its axes.
 *
 * @returns The rows each call visited.
 */
export function scenario(): unknown {
  const storage = register(createWorld(), Latch);
  spawn(storage, { LatchSpot: { x: 1 }, LatchBolt: true });
  spawn(storage, { LatchSpot: { x: 2 } });

  return [visit(storage, [Bolt]), visit(storage, { none: [Bolt] })];
}
