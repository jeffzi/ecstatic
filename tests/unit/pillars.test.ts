import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const PILLARS = readFileSync(new URL("../../docs/pillars.md", import.meta.url), "utf8");
const PILLAR_10_HEADING = "## 10. Runtime-first: the unoptimized runtime is the floor";

/** The pillars doc from the heading starting `heading` up to the next heading, or to the end. */
function section(heading: string): string {
  const start = PILLARS.indexOf(`\n${heading}`);
  const next = PILLARS.indexOf("\n## ", start + 1);
  return start === -1 ? "" : PILLARS.slice(start, next === -1 ? undefined : next);
}

describe("pillar 13", () => {
  it("names the runtime tree as the platform-neutral one and bundles its entry", () => {
    const pillar = section("## 13.");

    expect(pillar).toContain("`src/ecstatic/` uses only ECMAScript");
    expect(pillar).toContain("bundles `src/ecstatic/index.ts`");
  });
});

describe("pillar 10", () => {
  it("is titled after the unoptimized runtime and linked from the index", () => {
    expect(PILLARS).toContain(`\n${PILLAR_10_HEADING}\n`);
    expect(PILLARS).toContain("](#10-runtime-first-the-unoptimized-runtime-is-the-floor)");
  });

  it("names the optimizer the build-time optimizer", () => {
    const pillar = section(PILLAR_10_HEADING);

    expect(pillar).toContain("build-time optimizer");
  });
});
