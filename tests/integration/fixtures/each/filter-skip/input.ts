// rewrite-applies: filter-skip
// rewrite-applies: filter-element-guard
import { archetype, component, createWorld, each, register, spawn } from "ecstatic";

const Spot = component("MoatSpot", { x: 0 });
const Shield = component("MoatShield");
const Frozen = component("MoatFrozen");
const Keep = archetype([Spot], [Shield]);

/**
 * Skips a pass whose literal filter no row of the storage can satisfy: a bare array naming an absent component, an
 * absent `all` member beside a present one, only absent `any` members, and a required `none` member. The callback
 * never runs and no matcher is registered.
 *
 * @returns How many rows the callbacks visited and how many matchers the storage holds.
 */
export function scenario(): unknown {
  const storage = register(createWorld(), Keep);
  spawn(storage, { MoatSpot: { x: 1 }, MoatShield: true });
  spawn(storage, { MoatSpot: { x: 2 } });
  let rows = 0;

  each(storage, [Frozen], () => {
    rows += 1;
  });
  each(storage, { all: [Shield, Frozen] }, () => {
    rows += 10;
  });
  each(storage, { any: [Frozen] }, () => {
    rows += 100;
  });
  each(storage, { all: [Shield], none: [Spot] }, () => {
    rows += 1000;
  });

  return { rows, matchers: storage.matchers.length };
}
