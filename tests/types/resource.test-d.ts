import { describe, expectTypeOf, it } from "vitest";

import {
  createWorld,
  getResource,
  type Resource,
  resetResource,
  setResource,
} from "../../src/index.js";
import { resource } from "../../src/resource.js";

const Score = resource("ResourceTypeTestScore", { value: 0, label: "" });

describe("resource", () => {
  it("brands the ID so raw numbers are rejected", () => {
    const world = createWorld();

    // @ts-expect-error a raw number is not a Resource
    getResource(world, 0);
  });
});

describe("getResource", () => {
  it("returns the resource's field record", () => {
    const world = createWorld();

    expectTypeOf(getResource(world, Score)).toEqualTypeOf<{ value: number; label: string }>();
  });
});

describe("setResource", () => {
  it("accepts a partial of the field record", () => {
    const world = createWorld();

    setResource(world, Score, { value: 1 });
    setResource(world, Score, { value: 1, label: "x" });
  });

  it("rejects unknown field names and wrong field types", () => {
    const world = createWorld();

    // @ts-expect-error nope is not a field of Score
    setResource(world, Score, { nope: 1 });
    // @ts-expect-error value is a number
    setResource(world, Score, { value: "high" });
  });
});

describe("resetResource", () => {
  it("takes any resource and returns void", () => {
    expectTypeOf(resetResource).returns.toEqualTypeOf<void>();
    expectTypeOf(resetResource).parameter(1).toEqualTypeOf<Resource>();
  });
});
