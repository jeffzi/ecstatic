import { describe, it } from "vitest";

import { archetype, createWorld, register, spawn, spawnMany } from "../../src/index.js";
import { OnFire, Position, Shield, Stunned } from "./_fixtures.js";

describe("spawn optional overrides", () => {
  const world = createWorld();
  const storage = register(world, archetype([Position, OnFire], [Shield, Stunned]));

  it("accepts the true/false/record grammar on a data optional", () => {
    spawn(storage, { Shield: true });
    spawn(storage, { Shield: false });
    spawn(storage, { Shield: { hp: 75 } });
    spawnMany(storage, 2, { Shield: { hp: 75 } });
  });

  it("accepts only booleans on a tag optional", () => {
    spawn(storage, { Stunned: true });
    spawn(storage, { Stunned: false });
    // @ts-expect-error tag optionals carry no fields — records are rejected
    spawn(storage, { Stunned: {} });
  });

  it("narrows a required tag override to literal true", () => {
    spawn(storage, { OnFire: true });
    // @ts-expect-error required tags accept only `true` — the phase-3 `{}` acceptance is gone
    spawn(storage, { OnFire: {} });
    // @ts-expect-error required components cannot be disabled at spawn
    spawn(storage, { OnFire: false });
  });

  it("rejects false on a required data component", () => {
    // @ts-expect-error required components cannot be disabled at spawn
    spawn(storage, { Position: false });
  });

  it("rejects unknown component names", () => {
    // @ts-expect-error Velocity is not on this archetype
    spawn(storage, { Velocity: { vx: 1 } });
  });

  it("rejects unknown fields and wrong field types on optionals", () => {
    // @ts-expect-error "wrong" is not a field of Shield
    spawn(storage, { Shield: { wrong: 1 } });
    // @ts-expect-error string is not assignable to number
    spawn(storage, { Shield: { hp: "oops" } });
  });
});
