import { components, ref } from "../../src/index.js";

/** Shared fixtures for type tests. Never executed — type-checked only. */
export const { Position, Velocity, Health, Shield, Stunned, OnFire, Payload } = components({
  Position: { x: 0, y: 0 },
  Velocity: { vx: 0, vy: 0 },
  Health: { hp: 100 },
  Shield: { hp: 50 },
  Stunned: {},
  OnFire: {},
  Payload: { data: ref<number[]>() },
});
