// rewrite-applies: filter-runtime
// rewrite-applies: filter-runtime-object
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

const Spot = component("PrismSpot", { x: 0 });
const Red = component("PrismRed");
const Blue = component("PrismBlue");
const Dark = component("PrismDark");
const Prism = archetype([Spot], [Red, Blue]);

/**
 * Records the rows one call site visits.
 *
 * @param storage - The storage of the scenario, iterated through one call site.
 * @param filter - The filter object for this call; the scenario edits it between calls, so the cached resolution must notice.
 * @returns The `x` of each visited row, in visit order.
 */
function visit(storage: Storage<typeof Prism>, filter: EachFilter): number[] {
  const seen: number[] = [];
  each(storage, filter, (e) => {
    seen.push(e.PrismSpot.x);
  });
  return seen;
}

/**
 * Filters by objects held in bindings or built at the call, resolved on every call: absent axes and an axis a
 * JavaScript caller left `undefined` act as empty ones, each axis is read once per call through a getter, on the
 * call that resolves the filter and on the one that reuses it, and a change to the object, an axis, or an element
 * is seen by the next call. Objects built with a shorthand axis, an axis held in a binding, and a spread property
 * are resolved the same way.
 *
 * @returns The rows each call visited, every axis read, and the matchers the storage registered.
 */
export function scenario(): unknown {
  const storage = register(createWorld(), Prism);
  spawn(storage, { PrismSpot: { x: 1 }, PrismRed: true });
  spawn(storage, { PrismSpot: { x: 2 }, PrismRed: true, PrismBlue: true });
  spawn(storage, { PrismSpot: { x: 3 }, PrismBlue: true });
  spawn(storage, { PrismSpot: { x: 4 } });
  const reads: string[] = [];
  const any = [Red, Blue];
  const none = [Blue];
  const watched: EachFilter = {
    get any() {
      reads.push("any");
      return any;
    },
    get none() {
      reads.push("none");
      return none;
    },
  };
  // A JavaScript caller can leave an axis undefined, which the filter's type does not admit.
  const loose = { all: [Red], any: undefined } as unknown as EachFilter;
  const filter: { all: (typeof Spot | typeof Red | typeof Dark)[]; none?: (typeof Blue)[] } = {
    all: [Red],
  };
  const all = [Blue] as const;
  const base: EachFilter = { any: [Red, Blue] };

  const seen = [visit(storage, watched), visit(storage, watched)];
  reads.push("changed");
  none.pop();
  seen.push(visit(storage, watched), visit(storage, loose));
  seen.push(visit(storage, filter));
  filter.none = [Blue];
  seen.push(visit(storage, filter));
  filter.all[0] = Dark;
  seen.push(visit(storage, filter));
  filter.all = [Spot];
  seen.push(visit(storage, filter), visit(storage, { ...filter }));

  const seenBuilt: number[] = [];
  each(storage, { all }, (e) => {
    seenBuilt.push(e.PrismSpot.x);
  });
  each(storage, { ...base, none: [Red] }, (e) => {
    seenBuilt.push(e.PrismSpot.x * 10);
  });

  const matchers = storage.matchers.map((m) => [m.allMask, m.anyMask, m.noneMask]);
  return { seen, seenBuilt, reads, matchers };
}
