// rewrite-applies: filter-masked
// rewrite-applies: filter-element-guard
import { archetype, component, createWorld, each, register, spawn, type Storage } from "ecstatic";

const LeftSpot = component("TwinSpot", { x: 0 });
const RightSpot = component("TwinSpot", { x: 0 });
const Shield = component("TwinShield");
const Left = archetype([LeftSpot], [Shield]);
const Right = archetype([RightSpot], [Shield]);

/** Visits the rows of `storage` its literal filter's matcher flags, at one call site every storage passes through. */
function sweep(storage: Storage<typeof Left>): number[] {
  const seen: number[] = [];
  each(storage, [Shield], (e) => {
    seen.push(e.TwinSpot.x);
  });
  return seen;
}

/**
 * Passes storages of two archetypes of the same shape alternately to one call site whose literal filter folds to a
 * matcher: each storage gets its own matcher and its own rows on every call, rows spawned between calls included.
 *
 * @returns The rows each call visited, and how many matchers each storage holds.
 */
export function scenario(): unknown {
  const left = register(createWorld(), Left);
  const right = register(createWorld(), Right);
  spawn(left, { TwinSpot: { x: 1 }, TwinShield: true });
  spawn(left, { TwinSpot: { x: 2 } });
  spawn(right, { TwinSpot: { x: 10 } });
  spawn(right, { TwinSpot: { x: 20 }, TwinShield: true });
  spawn(right, { TwinSpot: { x: 30 }, TwinShield: true });
  const twin = right as unknown as Storage<typeof Left>;

  const visits = [sweep(left), sweep(twin), sweep(left), sweep(twin)];
  spawn(left, { TwinSpot: { x: 3 }, TwinShield: true });
  spawn(right, { TwinSpot: { x: 40 }, TwinShield: true });
  visits.push(sweep(twin), sweep(left));

  return { visits, matchers: [left.matchers.length, right.matchers.length] };
}
