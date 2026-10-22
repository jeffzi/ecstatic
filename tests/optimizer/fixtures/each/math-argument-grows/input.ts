// rewrite-applies: mode-realloc-safe
import { archetype, component, createWorld, each, get, register, spawn, spawnMany } from "ecstatic";

const Spot = component("MathSpot", { x: 0, y: 0 });

/**
 * Passes `Math` methods arguments whose conversion to a number spawns into the iterated storage
 * past its capacity, which replaces its columns: one typed `any`, one cast through `unknown`. Every
 * write after the call lands in the columns growth put in place, and the spawned rows are never
 * visited.
 *
 * @returns Each original row's fields after the loop, and how many rows the storage holds.
 */
export function scenario(): unknown {
  const storage = register(createWorld(), archetype([Spot]));
  const ids = [
    spawn(storage, { MathSpot: { x: 1.5, y: 0 } }),
    spawn(storage, { MathSpot: { x: 2.5, y: 0 } }),
  ];
  const growing = {
    valueOf(): number {
      spawnMany(storage, 20);
      return 4.5;
    },
  };
  // oxlint-disable-next-line typescript/no-explicit-any -- an any-typed Math argument is the case under test
  const loose: any = growing;

  each(storage, (e) => {
    e.MathSpot.x = Math.floor(e.MathSpot.x) + Math.round(loose);
    e.MathSpot.y = Math.max(e.MathSpot.x, growing as unknown as number);
  });

  return {
    fields: ids.map((id) => [get(storage, id, Spot.x), get(storage, id, Spot.y)]),
    rows: storage.n,
  };
}
