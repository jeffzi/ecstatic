import { archetype, component } from "ecstatic";

export const Position = component("Position", { x: 0, y: 0 });
export const Velocity = component("Velocity", { dx: 0, dy: 0 });
export const Health = component("Health", { hp: 0 });

export const Mover = archetype([Position, Velocity]);
export const Statue = archetype([Position, Health]);
