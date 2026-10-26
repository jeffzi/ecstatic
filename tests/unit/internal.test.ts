import { readFileSync } from "node:fs";

import {
  assertFilterMember as exposedAssertFilterMember,
  assertShape as exposedAssertShape,
  disableOne as exposedDisableOne,
  enableOne as exposedEnableOne,
  matcherFor as exposedMatcherFor,
  resolveFilterMasks as exposedResolveFilterMasks,
} from "ecstatic/internal";
import { describe, expect, it } from "vitest";

import { disableOne, enableOne } from "../../src/ecstatic/entity/optional.js";
import { resolveFilterMasks } from "../../src/ecstatic/filter.js";
import { matcherFor } from "../../src/ecstatic/matcher.js";
import { assertFilterMember, assertShape } from "../../src/ecstatic/shape-guard.js";

describe("ecstatic/internal", () => {
  it.each([
    { name: "matcherFor", exposed: exposedMatcherFor, runtime: matcherFor },
    { name: "resolveFilterMasks", exposed: exposedResolveFilterMasks, runtime: resolveFilterMasks },
    { name: "enableOne", exposed: exposedEnableOne, runtime: enableOne },
    { name: "disableOne", exposed: exposedDisableOne, runtime: disableOne },
    { name: "assertShape", exposed: exposedAssertShape, runtime: assertShape },
    {
      name: "assertFilterMember",
      exposed: exposedAssertFilterMember,
      runtime: assertFilterMember,
    },
  ])("exposes the runtime's own $name", ({ exposed, runtime }) => {
    expect(runtime).toBeTypeOf("function");
    expect(exposed).toBe(runtime);
  });

  it("exposes exactly the functions generated code calls", async () => {
    const internal: object = await import("ecstatic/internal");

    expect(Object.keys(internal).toSorted()).toStrictEqual([
      "assertFilterMember",
      "assertShape",
      "disableOne",
      "enableOne",
      "matcherFor",
      "resolveFilterMasks",
    ]);
  });

  it("is exported from the package manifest at the built internal entry", () => {
    const manifest: unknown = JSON.parse(
      readFileSync(new URL("../../package.json", import.meta.url), "utf-8"),
    );

    expect(manifest).toMatchObject({
      exports: {
        "./internal": { types: "./dist/internal.d.ts", default: "./dist/internal.js" },
      },
    });
  });
});
