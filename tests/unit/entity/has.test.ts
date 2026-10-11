import { describe, expect, it } from "vitest";

import {
  archetype,
  components,
  createWorld,
  despawn,
  disable,
  enable,
  has,
  hasAny,
  register,
  spawn,
} from "../../../src/index.js";

const { HasPosition: Position } = components({ HasPosition: { x: 0, y: 0 } });
const { HasStunned: Stunned } = components({ HasStunned: {} });
const { HasOnFire: OnFire } = components({ HasOnFire: {} });

function createStunnedStorage() {
  const world = createWorld();
  const storage = register(world, archetype([Position], [Stunned]));
  return { world, storage };
}

function createStunnedOnFireStorage() {
  const world = createWorld();
  const storage = register(world, archetype([Position], [Stunned, OnFire]));
  return { world, storage };
}

describe("has", () => {
  it("returns false when not enabled", () => {
    const { storage } = createStunnedStorage();
    const id = spawn(storage);

    expect(has(storage, id, [Stunned])).toBe(false);
  });

  it("returns true after enable", () => {
    const { storage } = createStunnedStorage();
    const id = spawn(storage);
    enable(storage, id, Stunned);

    expect(has(storage, id, [Stunned])).toBe(true);
  });

  it("returns false after disable", () => {
    const { storage } = createStunnedStorage();
    const id = spawn(storage);
    enable(storage, id, Stunned);
    disable(storage, id, Stunned);

    expect(has(storage, id, [Stunned])).toBe(false);
  });

  it("returns false when only one of multiple components is enabled", () => {
    const { storage } = createStunnedOnFireStorage();
    const id = spawn(storage);

    enable(storage, id, Stunned);
    expect(has(storage, id, [Stunned, OnFire])).toBe(false);
  });

  it("returns true when all requested components are enabled", () => {
    const { storage } = createStunnedOnFireStorage();
    const id = spawn(storage);

    enable(storage, id, Stunned);
    enable(storage, id, OnFire);
    expect(has(storage, id, [Stunned, OnFire])).toBe(true);
  });

  it("errors on stale ID", () => {
    const { storage } = createStunnedStorage();
    const id = spawn(storage);
    despawn(storage, id);

    expect(() => {
      has(storage, id, [Stunned]);
    }).toThrow("stale entity ID");
  });

  it("errors on non-optional component", () => {
    const { storage } = createStunnedStorage();
    const id = spawn(storage);

    expect(() => {
      // @ts-expect-error Position is required, not optional — runtime validates too
      has(storage, id, [Position]);
    }).toThrow("component HasPosition is not optional on this archetype");
  });

  it("errors on an empty component array", () => {
    const { storage } = createStunnedStorage();
    const id = spawn(storage);

    expect(() => {
      // @ts-expect-error the empty tuple is rejected at the type level too
      has(storage, id, []);
    }).toThrow("optional component check requires at least one component");
  });

  it("returns false for single component (positional form) when not enabled", () => {
    const { storage } = createStunnedStorage();
    const id = spawn(storage);

    expect(has(storage, id, Stunned)).toBe(false);
  });

  it("returns true for single component (positional form) after enable", () => {
    const { storage } = createStunnedStorage();
    const id = spawn(storage);
    enable(storage, id, Stunned);

    expect(has(storage, id, Stunned)).toBe(true);
  });
});

describe("hasAny", () => {
  it("returns false when no optional is enabled", () => {
    const { storage } = createStunnedOnFireStorage();
    const id = spawn(storage);

    expect(hasAny(storage, id, [Stunned, OnFire])).toBe(false);
  });

  it("returns true when at least one optional is enabled", () => {
    const { storage } = createStunnedOnFireStorage();
    const id = spawn(storage);
    enable(storage, id, Stunned);

    expect(hasAny(storage, id, [Stunned, OnFire])).toBe(true);
  });

  it("supports the has-none idiom via negation", () => {
    const { storage } = createStunnedOnFireStorage();
    const id = spawn(storage);

    expect(!hasAny(storage, id, [Stunned, OnFire])).toBe(true);
  });

  it("errors on stale ID", () => {
    const { storage } = createStunnedStorage();
    const id = spawn(storage);
    despawn(storage, id);

    expect(() => {
      hasAny(storage, id, [Stunned]);
    }).toThrow("stale entity ID");
  });

  it("errors on non-optional component", () => {
    const { storage } = createStunnedStorage();
    const id = spawn(storage);

    expect(() => {
      // @ts-expect-error Position is required, not optional — runtime validates too
      hasAny(storage, id, [Position]);
    }).toThrow("component HasPosition is not optional on this archetype");
  });

  it("errors on an empty component array", () => {
    const { storage } = createStunnedStorage();
    const id = spawn(storage);

    expect(() => {
      // @ts-expect-error the empty tuple is rejected at the type level too
      hasAny(storage, id, []);
    }).toThrow("optional component check requires at least one component");
  });
});

describe("has/hasAny world form", () => {
  it("has dispatches by id to the owning storage", () => {
    const { world, storage } = createStunnedStorage();
    const id = spawn(storage);
    enable(storage, id, Stunned);

    expect(has(world, id, Stunned)).toBe(true);
    expect(has(world, id, [Stunned])).toBe(true);
  });

  it("hasAny dispatches by id to the owning storage", () => {
    const { world, storage } = createStunnedOnFireStorage();
    const id = spawn(storage);
    enable(storage, id, OnFire);

    expect(hasAny(world, id, [Stunned, OnFire])).toBe(true);
  });

  it("errors on stale ID", () => {
    const { world, storage } = createStunnedStorage();
    const id = spawn(storage);
    despawn(storage, id);

    expect(() => {
      has(world, id, Stunned);
    }).toThrow("stale entity ID");
    expect(() => {
      hasAny(world, id, [Stunned]);
    }).toThrow("stale entity ID");
  });
});
