import { getStorage } from "ecstatic";
import { describe, expect, it } from "vitest";

import { bgArch, Position } from "../../benchmarks/archetypes.js";
import {
  DEFAULT_N,
  makeThroughputWorld,
  manualBench,
  warmedBench,
} from "../../benchmarks/helpers.js";
import { type BareWorldCtx, buildBareWorld, liveValues } from "./fixtures.js";

describe.each([
  { kind: "warmed", helper: warmedBench },
  { kind: "manual", helper: manualBench },
])("$kind description", ({ kind, helper }) => {
  it(`is marked ${kind} and carries the build and body without calling either`, () => {
    const calls: string[] = [];
    const build = (): BareWorldCtx => {
      calls.push("build");
      return buildBareWorld();
    };
    const body = (): void => {
      calls.push("body");
    };

    const description = helper(build, body);

    expect(description).toStrictEqual({ kind, build, body });
    expect(calls).toStrictEqual([]);
  });
});

describe("makeThroughputWorld", () => {
  it("builds a tracked storage of DEFAULT_N entities in a world with no background population", () => {
    const { world, trackedStorage } = makeThroughputWorld();

    expect(liveValues(trackedStorage, Position, "x")).toStrictEqual(
      Array.from({ length: DEFAULT_N }, (_, row) => row + 1),
    );
    expect(getStorage(world, bgArch).n).toBe(0);
  });
});
