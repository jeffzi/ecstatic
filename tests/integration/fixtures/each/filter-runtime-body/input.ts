// rewrite-applies: mode-realloc-safe
// rewrite-applies: filter-runtime
// rewrite-applies: filter-runtime-object
// rewrite-applies: read-optional-field
// rewrite-applies: write-required-field
// rewrite-applies: presence-optional
// rewrite-applies: return-void
// rewrite-applies: return-labeled
// rewrite-applies: var-to-let
// rewrite-applies: user-label
import {
  archetype,
  component,
  createWorld,
  each,
  type EachFilter,
  get,
  register,
  spawn,
} from "ecstatic";

const Spot = component("RelaySpot", { x: 0, total: 0 });
const Coil = component("RelayCoil", { turns: 0 });
const Fuse = component("RelayFuse");
const Relay = archetype([Spot], [Coil, Fuse]);

/**
 * Runs one body through the unfiltered loop, for a filter every row satisfies, and through the filtered loop, for
 * one only some rows satisfy: a labeled loop, a `var` that is its own binding on every row (read later through a closure), a
 * `return` that ends the row from inside a loop and from the body, a presence test, and reads and writes of the view's
 * fields behave alike in both.
 *
 * @returns What each row ran, in visit order, each row's tag as its closure reads it after the calls, and each row's
 * final total.
 */
export function scenario(): unknown {
  const storage = register(createWorld(), Relay);
  const ids = [
    spawn(storage, { RelaySpot: { x: 1 }, RelayCoil: { turns: 3 } }),
    spawn(storage, { RelaySpot: { x: 2 }, RelayFuse: true }),
    spawn(storage, { RelaySpot: { x: 3 }, RelayCoil: { turns: 2 }, RelayFuse: true }),
    spawn(storage, { RelaySpot: { x: 4 } }),
  ];
  const every: EachFilter = { all: [Spot] };
  const wired: EachFilter = { any: [Coil, Fuse] };
  const seen: string[] = [];
  const tags: (() => string)[] = [];

  for (const filter of [every, wired, every]) {
    seen.push("call");
    // fallow-ignore-next-line complexity -- the callback packs the forms under test into one body
    each(storage, filter, (e) => {
      // oxlint-disable-next-line no-var -- a body var is the behavior under test
      var tag = `${e.RelaySpot.x}`;
      tags.push(() => tag);
      if (e.RelayCoil === undefined) {
        seen.push(`${tag}:bare`);
        return;
      }
      winding: for (let turn = 0; turn < 4; turn++) {
        if (turn === e.RelayCoil.turns) break winding;
        if (e.RelayFuse && turn === 1) return;
        tag += `.${turn}`;
      }
      e.RelaySpot.total = e.RelaySpot.total + e.RelayCoil.turns;
      seen.push(tag);
    });
  }

  return {
    seen,
    tags: tags.map((read) => read()),
    totals: ids.map((id) => get(storage, id, Spot.total)),
  };
}
