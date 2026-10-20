import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const PILLARS = readFileSync(new URL("../../docs/pillars.md", import.meta.url), "utf8");
const PILLAR_10_HEADING = "## 10. Runtime-first: the unoptimized runtime is the floor";

describe("pillar 10", () => {
  it("is titled after the unoptimized runtime and linked from the index", () => {
    expect(PILLARS).toContain(`\n${PILLAR_10_HEADING}\n`);
    expect(PILLARS).toContain("](#10-runtime-first-the-unoptimized-runtime-is-the-floor)");
  });

  it("names the optimizer the build-time optimizer", () => {
    const section = PILLARS.slice(PILLARS.indexOf(PILLAR_10_HEADING), PILLARS.indexOf("\n## 11."));

    expect(section).toContain("build-time optimizer");
  });
});
