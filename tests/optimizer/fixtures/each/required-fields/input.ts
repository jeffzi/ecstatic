// rewrite-applies: mode-hoisted
// rewrite-applies: callback-arrow
// rewrite-applies: entity-id
// rewrite-applies: read-required-field
// rewrite-applies: write-required-field
// rewrite-applies: update-field
// rewrite-applies: required-tag
// rewrite-applies: presence-required
import { archetype, component, createWorld, each, get, register, spawn } from "ecstatic";

const Place = component("SteadyPlace", { x: 0, y: 0 });
const Drift = component("SteadyDrift", { dx: 0 });
const Anchored = component("SteadyAnchored");

/**
 * Reads, writes, and updates the fields of required components with every assignment form, reads `id` and a
 * required tag, and tests required slots, in a body that makes no call.
 *
 * @returns The ids in visit order, the values the body read, how often the presence tests held, and each row's
 * fields after the loop.
 */
export function scenario(): unknown {
  const storage = register(createWorld(), archetype([Place, Drift, Anchored]));
  const first = spawn(storage, { SteadyPlace: { x: 1, y: 0 }, SteadyDrift: { dx: 2 } });
  const second = spawn(storage, { SteadyPlace: { x: 5, y: 3 }, SteadyDrift: { dx: -1 } });
  const visited: number[] = [];
  const reads: unknown[] = [];
  let present = 0;

  // fallow-ignore-next-line complexity -- the callback packs the forms under test into one body
  each(storage, (e) => {
    visited[visited.length] = e.id;
    e.SteadyPlace.x += e.SteadyDrift.dx;
    e.SteadyPlace.x *= 2;
    e.SteadyPlace.y ||= 7;
    e.SteadyPlace.y &&= e.SteadyPlace.y + 1;
    // oxlint-disable-next-line typescript/no-unnecessary-condition -- a nullish assignment to a numeric field is a write form under test
    e.SteadyPlace.y ??= 0;
    e.SteadyDrift.dx = e.SteadyPlace.x - e.SteadyPlace.y;
    reads[reads.length] = e.SteadyPlace.x++;
    reads[reads.length] = ++e.SteadyPlace.x;
    reads[reads.length] = e.SteadyDrift.dx--;
    reads[reads.length] = --e.SteadyPlace.y;
    reads[reads.length] = e.SteadyAnchored;
    // oxlint-disable-next-line typescript/no-unnecessary-condition, typescript/strict-boolean-expressions -- testing a required slot is the lowering under test
    if (e.SteadyPlace) present += 1;
    // oxlint-disable-next-line typescript/no-unnecessary-condition -- comparing a required slot with undefined is the lowering under test
    if (e.SteadyDrift !== undefined) present += 10;
    // oxlint-disable-next-line typescript/no-unnecessary-condition, typescript/strict-boolean-expressions -- negating a required slot is the lowering under test
    if (!e.SteadyPlace) present += 100;
  });

  const fields = [first, second].map((id) => [
    get(storage, id, Place.x),
    get(storage, id, Place.y),
    get(storage, id, Drift.dx),
  ]);
  return { visited, reads, present, fields };
}
