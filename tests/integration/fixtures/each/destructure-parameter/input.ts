// rewrite-applies: destructure-parameter
// rewrite-applies: destructure-parameter-nested
// rewrite-applies: destructure-id
import { archetype, component, createWorld, each, get, ref, register, spawn } from "ecstatic";

const Spot = component("SignSpot", { x: 0, y: 0 });
const Pace = component("SignPace", { dx: 0, dy: 0 });
const Tally = component("SignTally", { first: ref<number>(), second: ref<number>() });

/**
 * Destructures the view in the callback's parameter: `id`, renamed and shorthand slot aliases whose writes reach
 * the columns, and nested field reads whose bindings stay assignable; then field defaults that see the enclosing
 * scope but not the names the body declares.
 *
 * @returns What the bodies bound, with each id as its index in spawn order, and each row's fields after the loops.
 */
export function scenario(): unknown {
  const storage = register(createWorld(), archetype([Spot, Pace, Tally]));
  const ids = [
    spawn(storage, {
      SignSpot: { x: 1, y: 2 },
      SignPace: { dx: 3, dy: 4 },
      SignTally: { first: 5 },
    }),
    spawn(storage, { SignSpot: { x: 5, y: 6 }, SignPace: { dx: 7, dy: 8 }, SignTally: {} }),
  ];
  const trace: unknown[] = [];
  const fallback = 100;

  each(storage, ({ id, SignSpot: p, SignPace: { dx: vx, dy } }) => {
    p.x += vx;
    // oxlint-disable-next-line no-param-reassign -- parameter-pattern bindings staying assignable is the behavior under test
    vx = 0;
    // oxlint-disable-next-line no-param-reassign -- parameter-pattern bindings staying assignable is the behavior under test
    dy *= 2;
    trace.push(ids.indexOf(id), p.x, vx, dy);
  });
  each(storage, ({ SignSpot, SignPace }) => {
    SignSpot.y += SignPace.dy;
    SignPace.dy = 0;
  });
  each(storage, ({ SignTally: { first = fallback, second = first } }) => {
    // oxlint-disable-next-line no-shadow -- a body name shadowing the one a parameter default reads is the behavior under test
    const fallback = 200;
    trace.push(first, second, fallback);
  });

  return {
    trace,
    fields: ids.map((id) => [
      get(storage, id, Spot.x),
      get(storage, id, Spot.y),
      get(storage, id, Pace.dy),
    ]),
  };
}
