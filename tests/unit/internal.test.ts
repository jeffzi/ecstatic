import {
  assertShape as exposedAssertShape,
  disableOne as exposedDisableOne,
  enableOne as exposedEnableOne,
  matcherFor as exposedMatcherFor,
  resolveFilter as exposedResolveFilter,
} from "ecstatic/internal";
import { describe, expect, it } from "vitest";

import { disableOne, enableOne } from "../../src/entity/optional.js";
import { resolveFilter } from "../../src/filter.js";
import { matcherFor } from "../../src/matcher.js";
import { assertShape } from "../../src/shape-guard.js";

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
});
