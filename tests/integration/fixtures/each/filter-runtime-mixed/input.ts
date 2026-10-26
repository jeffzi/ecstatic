// rewrite-applies: filter-runtime
// rewrite-applies: filter-runtime-mixed
import {
  archetype,
  component,
  createWorld,
  each,
  type EachFilter,
  register,
  spawn,
  type Storage,
} from "ecstatic";

const Spot = component("HingeSpot", { x: 0 });
const Pin = component("HingePin");
const Leaf = component("HingeLeaf");
const Hinge = archetype([Spot], [Pin, Leaf]);

/**
 * Records the rows one call site visits.
 *
 * @param storage - The storage of the scenario, iterated through one call site.
 * @param filter - A component array or a filter object, told apart on every call.
 * @returns The `x` of each visited row, in visit order.
 */
function visit(
  storage: Storage<typeof Hinge>,
  filter: EachFilter | readonly [typeof Pin | typeof Leaf, ...(typeof Pin | typeof Leaf)[]],
): number[] {
  const seen: number[] = [];
  each(storage, filter, (e) => {
    seen.push(e.HingeSpot.x);
  });
  return seen;
}

/**
 * Filters one call site by a value typed as a component array or a filter object, told apart on every call: an
 * array acts as its `all` axis and an object as its axes, whichever the previous call was given.
 *
 * @returns The rows each call visited.
 */
export function scenario(): unknown {
  const storage = register(createWorld(), Hinge);
  spawn(storage, { HingeSpot: { x: 1 }, HingePin: true });
  spawn(storage, { HingeSpot: { x: 2 }, HingePin: true, HingeLeaf: true });
  spawn(storage, { HingeSpot: { x: 3 }, HingeLeaf: true });
  const pinned: [typeof Pin] = [Pin];
  const loose: EachFilter = { any: pinned };
  const unpinned: EachFilter = { none: pinned };

  return [
    visit(storage, pinned),
    visit(storage, loose),
    visit(storage, unpinned),
    visit(storage, pinned),
    visit(storage, [Leaf]),
    visit(storage, { all: [Leaf], none: [Pin] }),
  ];
}
