import { join } from "node:path";

import { describe, expect, it } from "vitest";

import createOptimizerPlugin from "../../../src/plugin/optimizer.js";
import { REPO_ROOT } from "./tsconfig-fixtures.js";

describe("ecstatic/optimizer descriptor", () => {
  it.each(["src", "dist"])("points the plugin in %s/plugin at the optimizer sidecar", (out) => {
    const dirname = join(REPO_ROOT, out, "plugin");

    const descriptor = createOptimizerPlugin({ dirname });

    expect(descriptor).toStrictEqual({
      name: "ecstatic",
      source: join(REPO_ROOT, "optimizer"),
      hostInputHashes: {},
    });
  });
});
