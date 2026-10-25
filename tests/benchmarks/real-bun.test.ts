import { describe, expect, it } from "vitest";

import { requiresRealBun } from "./real-bun.js";

/** `""`, `"0"`, and `"false"` mean not CI; `"FALSE"` shows the comparison ignores case. */
const CI_VALUES = [
  { ci: undefined, isCi: false },
  { ci: "", isCi: false },
  { ci: "false", isCi: false },
  { ci: "FALSE", isCi: false },
  { ci: "0", isCi: false },
  { ci: "true", isCi: true },
  { ci: "1", isCi: true },
];

describe("requiresRealBun", () => {
  it.each(CI_VALUES)("runs the case wherever Bun is installed, with CI=$ci", ({ ci }) => {
    expect(requiresRealBun(true, ci)).toBe(true);
  });

  it.each(CI_VALUES)("without Bun, with CI=$ci, runs the case: $isCi", ({ ci, isCi }) => {
    expect(requiresRealBun(false, ci)).toBe(isCi);
  });
});
