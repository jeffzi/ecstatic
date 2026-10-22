// rewrite-applies: user-label-renamed
import { archetype, component, createWorld, each, register, spawn } from "ecstatic";

const Knot = component("SpindleKnot", { x: 0 });

/**
 * Runs a body whose loop reuses the label of the loop enclosing the call, so that the body's `break` and `continue`
 * still name the body's loop, beside a nested function that declares the same label for itself.
 *
 * @returns What each pass and row ran, in visit order.
 */
export function scenario(): unknown {
  const storage = register(createWorld(), archetype([Knot]));
  for (const x of [1, 2, 3]) {
    spawn(storage, { SpindleKnot: { x } });
  }
  const seen: string[] = [];

  outer: for (let pass = 0; pass < 2; pass++) {
    // fallow-ignore-next-line complexity -- the callback packs the forms under test into one body
    each(storage, (e) => {
      outer: for (let a = 0; a < 3; a++) {
        for (let b = 0; b < 3; b++) {
          if (b === 1) continue outer;
          if (a === 1) break outer;
          seen.push(`${pass}:${e.SpindleKnot.x}:${a}${b}`);
        }
      }
      const nested = (): string => {
        outer: for (;;) break outer;
        return "nested";
      };
      seen.push(nested());
    });
    if (pass === 0) continue outer;
    break outer;
  }

  return seen;
}
