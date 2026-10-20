import { archetype, component, createWorld, each, ref, register, spawn } from "ecstatic";

const Hook = component("Hook", { run: ref<() => string>() });
const Hooked = archetype([Hook]);

/** Calls a field as a method, which runs it with the slot record as `this`. */
export function scenario(): unknown {
  const world = createWorld();
  const hooked = register(world, Hooked);
  spawn(hooked, {
    Hook: {
      run(this: unknown): string {
        return Array.isArray(this) ? "array" : typeof this;
      },
    },
  });
  const receivers: (string | undefined)[] = [];

  // expect-diagnostic: 99918 VIEW_ESCAPES
  each(hooked, (e) => {
    receivers.push(e.Hook.run?.());
  });

  return { receivers };
}
