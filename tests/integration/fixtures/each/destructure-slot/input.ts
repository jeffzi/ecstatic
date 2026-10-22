// rewrite-applies: destructure-slot
import { archetype, component, createWorld, each, get, register, spawn } from "ecstatic";

const Spot = component("CopySpot", { x: 0, y: 0 });
const Pace = component("CopyPace", { dx: 0, dy: 0 });

/**
 * Destructures slots in `const` and `let` declarations, renamed and not: the bindings copy the fields, `let` ones
 * stay assignable, and writing them never writes the columns back.
 *
 * @returns What the body bound, and each row's `x` after the loop.
 */
export function scenario(): unknown {
  const storage = register(createWorld(), archetype([Spot, Pace]));
  const ids = [
    spawn(storage, { CopySpot: { x: 1, y: 2 }, CopyPace: { dx: 3, dy: 4 } }),
    spawn(storage, { CopySpot: { x: 5, y: 6 }, CopyPace: { dx: 7, dy: 8 } }),
  ];
  const trace: unknown[] = [];

  each(storage, (e) => {
    const { x, y: py } = e.CopySpot;
    let { dx: vx, dy } = e.CopyPace;
    vx += 100;
    dy = x;
    e.CopySpot.x = vx;
    trace.push(x, py, vx, dy, e.CopySpot.x, e.CopyPace.dy);
  });

  return { trace, xs: ids.map((id) => get(storage, id, Spot.x)) };
}
