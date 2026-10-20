import { readFileSync } from "node:fs";

import {
  assertShape as exposedAssertShape,
  disableOne as exposedDisableOne,
  enableOne as exposedEnableOne,
  matcherFor as exposedMatcherFor,
  resolveFilter as exposedResolveFilter,
} from "ecstatic/internal";
import { describe, expect, it } from "vitest";

import { disableOne, enableOne } from "../../src/ecstatic/entity/optional.js";
import { resolveFilter } from "../../src/ecstatic/filter.js";
import { matcherFor } from "../../src/ecstatic/matcher.js";
import { assertShape } from "../../src/ecstatic/shape-guard.js";

describe("ecstatic/internal", () => {
  it.each([
    { name: "matcherFor", exposed: exposedMatcherFor, runtime: matcherFor },
    { name: "resolveFilter", exposed: exposedResolveFilter, runtime: resolveFilter },
    { name: "enableOne", exposed: exposedEnableOne, runtime: enableOne },
    { name: "disableOne", exposed: exposedDisableOne, runtime: disableOne },
    { name: "assertShape", exposed: exposedAssertShape, runtime: assertShape },
  ])("exposes the runtime's own $name", ({ exposed, runtime }) => {
    expect(exposed).toBe(runtime);
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
