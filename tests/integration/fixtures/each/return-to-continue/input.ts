// rewrite-applies: return-void
// rewrite-applies: return-value
// rewrite-applies: return-labeled
// rewrite-applies: return-in-finally
// rewrite-applies: return-object-literal
// rewrite-applies: return-function-expression
// rewrite-applies: return-class-expression
import { archetype, component, createWorld, each, register, spawn } from "ecstatic";

const Step = component("LadderStep", { x: 0 });

/**
 * Returns early from the callback: with no value; with a value, an object literal, a function expression, and a
 * class expression included, whose expression still runs; from under a nested loop and a `switch`, which ends the row rather than
 * the inner statement; and from inside `try … finally`, whose `finally` still runs.
 *
 * @returns What each row ran before it ended, in visit order.
 */
export function scenario(): unknown {
  const storage = register(createWorld(), archetype([Step]));
  for (const x of [1, 2, 3]) {
    spawn(storage, { LadderStep: { x } });
  }
  const trace: unknown[] = [];
  const note = (value: unknown): unknown => {
    trace.push(value);
    return value;
  };

  each(storage, (e) => {
    if (e.LadderStep.x === 2) return;
    trace.push(`plain ${e.LadderStep.x}`);
  });
  each(storage, (e) => {
    if (e.LadderStep.x === 1) return { at: note(e.LadderStep.x), twice: note(e.LadderStep.x * 2) };
    if (e.LadderStep.x === 2) {
      return function () {
        trace.push("never");
      };
    }
    if (e.LadderStep.x === 3) {
      return class {
        static {
          trace.push(`class ${e.LadderStep.x}`);
        }
      };
    }
    return note(e.LadderStep.x * 10);
  });
  // fallow-ignore-next-line complexity -- the callback packs the forms under test into one body
  each(storage, (e) => {
    for (let k = 0; k < 3; k++) {
      if (k === 1 && e.LadderStep.x === 2) return;
      trace.push(`${e.LadderStep.x}:${k}`);
    }
    switch (e.LadderStep.x) {
      case 3:
        return;
      default:
        trace.push(`${e.LadderStep.x}:end`);
    }
    trace.push(`${e.LadderStep.x}:after`);
  });
  each(storage, (e) => {
    try {
      if (e.LadderStep.x === 2) return;
      trace.push(`try ${e.LadderStep.x}`);
    } finally {
      trace.push(`finally ${e.LadderStep.x}`);
    }
    trace.push(`after ${e.LadderStep.x}`);
  });

  return trace;
}
