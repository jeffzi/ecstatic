import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("DEBUG", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  // Restores the prior value rather than deleting it, so a project-level `NDEBUG` define survives
  // these tests in any order.
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("is true when no NDEBUG global is defined #checked", async () => {
    const { DEBUG } = await import("../../src/debug.js");

    expect(DEBUG).toBe(true);
  });

  it("is false when globalThis.NDEBUG is truthy", async () => {
    vi.stubGlobal("NDEBUG", true);

    const { DEBUG } = await import("../../src/debug.js");

    expect(DEBUG).toBe(false);
  });
});
