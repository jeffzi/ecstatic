// rewrite-applies: filter-masked
// rewrite-applies: filter-skip
// rewrite-applies: filter-element-guard
import { archetype, component, createWorld, each, register, spawn, type Storage } from "ecstatic";

const Spot = component("OrderSpot", { x: 0 });
const Shield = component("OrderShield");
const Boost = component("OrderBoost");
const Frozen = component("OrderFrozen");
const Ship = archetype([Spot], [Shield, Boost]);

/**
 * Runs a Masked and a Skip pass whose filter reads a binding in its temporal dead zone, before and after the binding
 * is initialized.
 *
 * @param storage - The storage both passes iterate.
 * @param trace - Receives every evaluation, row, and error.
 * @param pick - Records `label`, then returns `value`.
 */
function deadZone(
  storage: Storage<typeof Ship>,
  trace: unknown[],
  pick: <T>(label: string, value: T) => T,
): void {
  const masked = (): void => {
    each(
      pick("dead-zone storage", storage),
      [pick("before", Shield), late, pick("after", Boost)],
      (e) => {
        trace.push("dead-zone row", e.OrderSpot.x);
      },
    );
  };
  const skipped = (): void => {
    each(pick("dead-zone skipped storage", storage), [pick("skip before", Frozen), late], () => {
      trace.push("dead-zone skipped row");
    });
  };
  for (const run of [masked, skipped]) {
    try {
      run();
    } catch (error) {
      trace.push(error instanceof Error ? error.constructor.name : typeof error);
    }
  }
  const late = Shield;
  masked();
  skipped();
}

/**
 * Evaluates the storage argument, then each literal filter element in source order, once per call and before any
 * row: a call, a getter, and a binding in its temporal dead zone among the elements run or throw as the runtime's
 * call does, on a pass the filter folds to a matcher and on one it folds to a skip.
 *
 * @returns Every evaluation, row, and error, in the order they happened.
 */
export function scenario(): unknown {
  const storage = register(createWorld(), Ship);
  spawn(storage, { OrderSpot: { x: 1 }, OrderShield: true });
  spawn(storage, { OrderSpot: { x: 2 }, OrderShield: true, OrderBoost: true });
  spawn(storage, { OrderSpot: { x: 3 } });
  const trace: unknown[] = [];
  const pick = <T>(label: string, value: T): T => {
    trace.push(label);
    return value;
  };
  const parts = {
    get shield(): typeof Shield {
      trace.push("get shield");
      return Shield;
    },
  };

  for (const round of [1, 2]) {
    trace.push("round", round);
    each(
      pick("storage", storage),
      { none: [pick("none", Boost)], all: [parts.shield, pick("all", Spot)] },
      (e) => {
        trace.push("row", e.OrderSpot.x);
      },
    );
    each(
      pick("skipped storage", storage),
      { any: [pick("any", Frozen)], all: [parts.shield] },
      () => {
        trace.push("skipped row");
      },
    );
  }

  deadZone(storage, trace, pick);

  return trace;
}
