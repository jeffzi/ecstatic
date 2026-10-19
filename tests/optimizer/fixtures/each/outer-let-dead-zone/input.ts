// rewrite-applies: mode-realloc-safe
// rewrite-applies: outer-let-dead-zone
import { archetype, component, createWorld, each, register, spawn } from "ecstatic";

const Tick = component("ClockTick", { x: 0 });

/**
 * Reads an outer `let` in its temporal dead zone from the body, which throws at the same point as the runtime's
 * call: after the first row's earlier statements ran.
 *
 * @returns What the body recorded before the read threw, the constructor name of the error, and the `let` once
 * initialized.
 */
export function scenario(): unknown {
  const storage = register(createWorld(), archetype([Tick]));
  for (const x of [1, 2, 3]) {
    spawn(storage, { ClockTick: { x } });
  }
  const seen: unknown[] = [];
  try {
    each(storage, (e) => {
      seen.push(e.ClockTick.x);
      seen.push(later);
    });
  } catch (error) {
    seen.push(error instanceof Error ? error.constructor.name : typeof error);
  }
  let later = "late";
  later += "!";

  return { seen, later };
}
