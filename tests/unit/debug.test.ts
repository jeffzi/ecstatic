import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("DEBUG", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    // biome-ignore lint: test cleanup of global
    delete (globalThis as Record<string, unknown>)["NDEBUG"];
  });

  it("is true when no NDEBUG global is defined", async () => {
    const { DEBUG } = await import("../../src/debug.js");

    expect(DEBUG).toBe(true);
  });

  it("is false when globalThis.NDEBUG is truthy", async () => {
    (globalThis as Record<string, unknown>)["NDEBUG"] = true;

    const { DEBUG } = await import("../../src/debug.js");

    expect(DEBUG).toBe(false);
  });
});
