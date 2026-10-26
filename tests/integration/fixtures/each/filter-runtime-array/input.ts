// rewrite-applies: filter-runtime
// rewrite-applies: filter-runtime-array
import { archetype, component, createWorld, each, register, spawn, type Storage } from "ecstatic";

const Spot = component("AbacusSpot", { x: 0 });
const Bead = component("AbacusBead");
const Rod = component("AbacusRod");
const Frame = component("AbacusFrame");
const Abacus = archetype([Spot], [Bead, Rod]);

type Member = typeof Spot | typeof Bead | typeof Rod | typeof Frame;

/** A bare component array, which names at least one component. */
type Members = [Member, ...Member[]];

/**
 * Records the rows one call site visits for a bare component array.
 *
 * @param storage - The storage of the scenario, iterated through one call site.
 * @param filter - The component array for this call, its `all` axis; the scenario edits it between calls.
 * @returns The `x` of each visited row, in visit order.
 */
function visit(storage: Storage<typeof Abacus>, filter: Readonly<Members>): number[] {
  const seen: number[] = [];
  each(storage, filter, (e) => {
    seen.push(e.AbacusSpot.x);
  });
  return seen;
}

/**
 * Filters one call site by a bare component array held in a binding, which acts as its `all` axis and is resolved
 * on every call: the same array again, a pushed, a popped, and a replaced element, an absent member, a required one,
 * a new array of the same contents, an array built with a spread element, and another storage.
 *
 * @returns The rows each call visited, and the matchers each storage registered.
 */
export function scenario(): unknown {
  const storage = register(createWorld(), Abacus);
  spawn(storage, { AbacusSpot: { x: 1 }, AbacusBead: true });
  spawn(storage, { AbacusSpot: { x: 2 }, AbacusBead: true, AbacusRod: true });
  spawn(storage, { AbacusSpot: { x: 3 }, AbacusRod: true });
  spawn(storage, { AbacusSpot: { x: 4 } });
  const other = register(createWorld(), Abacus);
  spawn(other, { AbacusSpot: { x: 5 }, AbacusRod: true });
  const all: Members = [Bead];
  const rest: Members = [Rod];
  const seen = [visit(storage, all), visit(storage, all)];
  all.push(Rod);
  seen.push(visit(storage, all));
  all.pop();
  seen.push(visit(storage, all));
  all[0] = Rod;
  seen.push(visit(storage, all));
  all[0] = Frame;
  seen.push(visit(storage, all));
  all[0] = Spot;
  seen.push(visit(storage, all), visit(storage, [Spot]), visit(storage, [...rest, Bead]));
  seen.push(visit(other, rest), visit(storage, rest));

  const matchers = [storage, other].map((s) =>
    s.matchers.map((m) => [m.allMask, m.anyMask, m.noneMask]),
  );
  return { seen, matchers };
}
