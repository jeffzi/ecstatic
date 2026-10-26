// rewrite-applies: mode-hoisted
import { archetype, component, createWorld, each, query, register, spawn } from "ecstatic";

const Rope = component("PierRope", { length: 0 });
const Crate = component("PierCrate", { weight: 0 });
const Buoy = component("PierBuoy", { lit: 0 });

/**
 * Keeps an each over an array literal and a query beside two each calls the optimizer compiles into loops, one of
 * them filtered; the kept calls, their line breaks, and their comments are emitted as written. The array-literal and
 * query callbacks hand their view to a helper, which reports nothing: those call forms have no rewrite to lose.
 *
 * @returns What each call saw, in call order.
 */
export function scenario(): unknown {
  const world = createWorld();
  const moorings = register(world, archetype([Rope, Crate]));
  const markers = register(world, archetype([Rope, Buoy]));
  spawn(moorings, { PierRope: { length: 3 }, PierCrate: { weight: 5 } });
  spawn(markers, { PierRope: { length: 7 }, PierBuoy: { lit: 1 } });
  const trace: unknown[] = [];
  const note = (
    label: string,
    view: { readonly id: number; readonly PierRope: { readonly length: number } },
  ): void => {
    trace.push([label, view.id, view.PierRope.length]);
  };

  // A literal filter is compiled with its call.
  each(
    moorings,
    [Crate], // the filter
    (e) => {
      trace.push(["filtered", e.id, e.PierCrate.weight]);
    },
  );

  each(moorings, (e) => {
    e.PierRope.length += 1;
  });

  each(
    [moorings, markers], // two storages
    (e) => {
      note("array", e);
    },
  );

  query(
    world,
    [Rope], // every rope, in either storage
    (e) => {
      note("query", e);
    },
  );

  return { trace };
}
