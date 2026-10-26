// rewrite-applies: filter-trivial
// rewrite-applies: filter-element-guard
import { archetype, component, createWorld, each, register, spawn } from "ecstatic";

const Spot = component("PlainSpot", { x: 0 });
const Shield = component("PlainShield");
const Frozen = component("PlainFrozen");
const Field = archetype([Spot], [Shield]);

/**
 * Visits every row, from the last to the first, for a literal filter every row satisfies: a required `all` member,
 * an empty `any`, empty `all` and `none`, an absent `none` member, and an `any` holding a required member. No
 * matcher is registered.
 *
 * @returns The rows each call visited, in visit order, and how many matchers the storage holds.
 */
export function scenario(): unknown {
  const storage = register(createWorld(), Field);
  spawn(storage, { PlainSpot: { x: 1 }, PlainShield: true });
  spawn(storage, { PlainSpot: { x: 2 } });
  spawn(storage, { PlainSpot: { x: 3 }, PlainShield: true });
  const seen: unknown[] = [];

  seen.push("required all");
  each(storage, [Spot], (e) => {
    seen.push(e.PlainSpot.x);
  });
  seen.push("empty any");
  each(storage, { any: [] }, (e) => {
    seen.push(e.PlainSpot.x);
  });
  seen.push("empty all and none");
  each(storage, { all: [], none: [] }, (e) => {
    seen.push(e.PlainSpot.x);
  });
  seen.push("absent none");
  each(storage, { none: [Frozen] }, (e) => {
    seen.push(e.PlainSpot.x);
  });
  seen.push("required any");
  each(storage, { any: [Shield, Spot] }, (e) => {
    seen.push(e.PlainSpot.x);
  });

  return { seen, matchers: storage.matchers.length };
}
