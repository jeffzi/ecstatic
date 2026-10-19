// rewrite-applies: user-label
// rewrite-applies: return-labeled
import { archetype, component, createWorld, each, register, spawn } from "ecstatic";

const Rung = component("TrellisRung", { x: 0 });

/**
 * Runs labeled loops and a labeled block in the body, with `break` and `continue` that name them and unlabeled
 * ones, beside a `return` that ends the row from inside a loop.
 *
 * @returns What each row ran, in visit order.
 */
export function scenario(): unknown {
  const storage = register(createWorld(), archetype([Rung]));
  for (const x of [1, 2, 3]) {
    spawn(storage, { TrellisRung: { x } });
  }
  const seen: string[] = [];

  // fallow-ignore-next-line complexity -- the callback packs the forms under test into one body
  each(storage, (e) => {
    row: for (let a = 0; a < 3; a++) {
      for (let b = 0; b < 3; b++) {
        if (b === 1) continue row;
        if (a === 2) break row;
        seen.push(`${e.TrellisRung.x}:${a}${b}`);
      }
    }
    block: {
      if (e.TrellisRung.x === 2) break block;
      seen.push(`${e.TrellisRung.x}:block`);
    }
    for (let k = 0; k < 2; k++) {
      if (k === 0) continue;
      if (e.TrellisRung.x === 1) return;
      seen.push(`${e.TrellisRung.x}:k${k}`);
    }
  });

  return seen;
}
