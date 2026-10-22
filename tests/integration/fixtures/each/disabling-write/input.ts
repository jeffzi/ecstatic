// rewrite-applies: write-optional-field
// rewrite-applies: boolean-assignment-value
import {
  archetype,
  component,
  createWorld,
  disable,
  each,
  enable,
  get,
  register,
  spawn,
} from "ecstatic";

const Spot = component("FenceSpot", { x: 0 });
const Gate = component("FenceGate", { hp: 0, shut: false });

/**
 * Writes an optional component's fields with right-hand sides that disable it, which never makes the write throw:
 * the write lands in the column as the runtime's accessor record does.
 *
 * @returns The values the boolean assignments yielded, and the gated row's fields after the loop.
 */
export function scenario(): unknown {
  const storage = register(createWorld(), archetype([Spot], [Gate]));
  const gated = spawn(storage, { FenceSpot: { x: 1 }, FenceGate: { hp: 5, shut: true } });
  spawn(storage, { FenceSpot: { x: 2 } });
  const trace: unknown[] = [];

  each(storage, (e) => {
    // oxlint-disable-next-line typescript/strict-boolean-expressions -- testing an optional slot is the lowering under test
    if (!e.FenceGate) return;
    e.FenceGate.hp = (disable(storage, e.id, Gate), 7);
    enable(storage, e.id, Gate);
    e.FenceGate.hp += (disable(storage, e.id, Gate), 1);
    enable(storage, e.id, Gate);
    trace.push((e.FenceGate.shut = (disable(storage, e.id, Gate), false)));
    enable(storage, e.id, Gate);
    trace.push((e.FenceGate.shut ||= (disable(storage, e.id, Gate), true)));
    enable(storage, e.id, Gate);
  });

  return { trace, hp: get(storage, gated, Gate.hp), shut: get(storage, gated, Gate.shut) };
}
