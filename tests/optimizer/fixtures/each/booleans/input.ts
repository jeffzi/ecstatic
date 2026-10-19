// rewrite-applies: read-boolean-field
// rewrite-applies: write-boolean-field
// rewrite-applies: boolean-assignment-value
import { archetype, component, createWorld, each, get, register, spawn } from "ecstatic";

const Switch = component("LampSwitch", { on: false });
const Shade = component("LampShade", { open: false, tint: 0 });

/**
 * Reads boolean fields of a required and an optional component, stores them, and uses the value of boolean
 * assignments, logical forms that short-circuit included.
 *
 * @returns What the body read and the assignments yielded, and each row's booleans after the loop.
 */
export function scenario(): unknown {
  const storage = register(createWorld(), archetype([Switch], [Shade]));
  const shaded = spawn(storage, { LampSwitch: { on: true }, LampShade: { open: true, tint: 3 } });
  const bare = spawn(storage, { LampSwitch: { on: false } });
  const trace: unknown[] = [];

  // fallow-ignore-next-line complexity -- the callback packs the forms under test into one body
  each(storage, (e) => {
    trace.push(e.LampSwitch.on, !e.LampSwitch.on);
    e.LampSwitch.on = !e.LampSwitch.on;
    trace.push((e.LampSwitch.on = true), (e.LampSwitch.on ||= false), (e.LampSwitch.on &&= false));
    // oxlint-disable-next-line typescript/no-unnecessary-condition -- a nullish assignment to a boolean field is a form under test
    trace.push((e.LampSwitch.on &&= true), (e.LampSwitch.on ??= true));
    // oxlint-disable-next-line typescript/strict-boolean-expressions -- testing an optional slot is the lowering under test
    if (e.LampShade) {
      trace.push(e.LampShade.open, e.LampShade.tint);
      e.LampShade.open = false;
      trace.push((e.LampShade.open ||= true), (e.LampShade.open ||= false), e.LampShade.open);
    }
  });

  return {
    trace,
    on: [shaded, bare].map((id) => get(storage, id, Switch.on)),
    open: get(storage, shaded, Shade.open),
  };
}
