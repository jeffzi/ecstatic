import { archetype, component, createWorld, each, register, spawn } from "ecstatic";

const Switch = component("Switch", { on: true });
const Switched = archetype([Switch]);

/** Increments a boolean field, which yields a number and stores whether the result is `true`. */
export function scenario(): unknown {
  const world = createWorld();
  const switched = register(world, Switched);
  spawn(switched);
  const seen: unknown[] = [];

  // expect-diagnostic: 99918 VIEW_ESCAPES 3 `line 16, column 15: arithmetic on a boolean field`
  each(switched, (e) => {
    // @ts-expect-error -- incrementing a boolean field is the behavior under test
    seen.push(e.Switch.on++, e.Switch.on);
  });

  return { seen };
}
