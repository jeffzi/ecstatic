import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const PROJECT_NDEBUG: unknown = Reflect.get(globalThis, "NDEBUG");

describe("DEBUG", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  // Restores the prior value rather than deleting it, so a project-level `NDEBUG` define survives
  // these tests in any order.
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // Tests run shuffled; after all of them, the project's NDEBUG must be back.
  afterAll(() => {
    const ndebug: unknown = Reflect.get(globalThis, "NDEBUG");
    if (ndebug !== PROJECT_NDEBUG) throw new Error(`NDEBUG is ${String(ndebug)} after the tests`);
  });

  it("is true when no NDEBUG global is defined #checked", async () => {
    const { DEBUG } = await import("../../src/ecstatic/debug.js");

    expect(DEBUG).toBe(true);
  });

  it("is false when globalThis.NDEBUG is truthy", async () => {
    vi.stubGlobal("NDEBUG", true);

    const { DEBUG } = await import("../../src/ecstatic/debug.js");

    expect(DEBUG).toBe(false);
  });
});
