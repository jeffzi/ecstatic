import { archetype, component } from "ecstatic";

/**
 * A component named as `input.ts`'s spawn component but with another field. Defining it beside that
 * component throws, so `input.ts` imports its type alone and this module never runs there.
 */
const Twin = component("LyingSpot", { z: 0 });

export const TwinShape = archetype([Twin]);
