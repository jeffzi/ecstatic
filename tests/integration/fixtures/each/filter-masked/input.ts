// rewrite-applies: mode-hoisted
// rewrite-applies: filter-masked
// rewrite-applies: filter-element-guard
import {
  archetype,
  component,
  createWorld,
  disable,
  each,
  enable,
  get,
  register,
  spawn,
} from "ecstatic";

const Spot = component("SieveSpot", { x: 0, order: 0 });
const Shield = component("SieveShield", { hp: 0 });
const Boost = component("SieveBoost");
const Stun = component("SieveStun");
const Sieve = archetype([Spot], [Shield, Boost, Stun]);

/**
 * Visits, from the last row to the first, exactly the rows a literal filter's matcher flags when the loop reaches
 * them, in a body that compiles hoisted. The first call registers the matcher before testing the row count, even on
 * an empty storage, and every later call reuses it. An `enable` or `disable` in the body changes which rows not yet
 * visited are visited.
 *
 * @returns Each row's visit record after every sweep, the matchers registered by the sweep over the empty storage,
 * and the matchers registered once every sweep ran.
 */
export function scenario(): unknown {
  const storage = register(createWorld(), Sieve);
  const matchers = (): number[][] =>
    storage.matchers.map((m) => [m.allMask, m.anyMask, m.noneMask]);
  let step = 0;
  const sweep = (): void => {
    step = 0;
    each(storage, { all: [Shield], none: [Stun] }, (e) => {
      step += 1;
      e.SieveSpot.order = e.SieveSpot.order * 10 + step;
    });
    each(storage, { any: [Boost, Stun] }, (e) => {
      step += 1;
      e.SieveSpot.order = e.SieveSpot.order * 10 + step;
    });
  };

  sweep();
  const registeredEmpty = matchers();
  const first = spawn(storage, { SieveSpot: { x: 1 }, SieveShield: { hp: 1 } });
  const second = spawn(storage, { SieveSpot: { x: 2 }, SieveShield: { hp: 2 }, SieveStun: true });
  const third = spawn(storage, { SieveSpot: { x: 3 } });
  const fourth = spawn(storage, { SieveSpot: { x: 4 }, SieveShield: { hp: 4 }, SieveBoost: true });
  const fifth = spawn(storage, { SieveSpot: { x: 5 }, SieveBoost: true });
  const ids = [first, second, third, fourth, fifth];
  const orders: number[][] = [];
  const record = (): void => {
    orders.push(ids.map((id) => get(storage, id, Spot.order)));
  };
  sweep();
  record();
  sweep();
  record();

  each(storage, { all: [Shield] }, (e) => {
    step += 1;
    e.SieveSpot.order = step;
    if (e.SieveSpot.x === 4) {
      disable(storage, first, Shield);
      enable(storage, third, Shield);
    }
  });
  record();

  return { orders, registeredEmpty, matchers: matchers() };
}
