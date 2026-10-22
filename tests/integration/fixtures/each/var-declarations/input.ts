// rewrite-applies: var-to-let
import { archetype, component, createWorld, each, register, spawn } from "ecstatic";

const Wick = component("CandleWick", { x: 0 });

/**
 * Declares `var` bindings in the body, which are fresh on every row and never hoist into the enclosing function.
 *
 * @returns What the body read of its `var` bindings, row by row, then the enclosing function's bindings of the
 * same names after the loop.
 */
export function scenario(): unknown {
  const storage = register(createWorld(), archetype([Wick]));
  for (const x of [1, 2, 3]) {
    spawn(storage, { CandleWick: { x } });
  }
  const marker = "outer";
  const seen: unknown[] = [];

  each(storage, (e) => {
    seen.push(typeof carried);
    // oxlint-disable-next-line no-var -- a body var is the behavior under test
    var carried: number | undefined = e.CandleWick.x;
    // oxlint-disable-next-line no-var -- a body var is the behavior under test
    var unset: number | undefined;
    seen.push(unset ?? "fresh", carried);
    unset = carried;
    // oxlint-disable-next-line no-var, no-shadow -- a body var shadowing an outer binding is the behavior under test
    var marker = e.CandleWick.x;
    seen.push(marker, unset);
  });

  return { seen, marker };
}
