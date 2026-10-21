import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createVitest, type Vitest } from "vitest/node";

import { REPO_ROOT } from "./plugin/tsconfig-fixtures.js";

const RAW = readFileSync(join(REPO_ROOT, "AGENTS.md"), "utf8");

// Collapsed to single spaces so a phrase matches however the prose wraps.
const AGENTS = RAW.replaceAll(/\s+/gu, " ");

/**
 * SHA-256 of each section that must stay as the main branch has it, from its heading up to the next
 * one. A deliberate edit to one of these sections updates its hash here.
 */
const PINNED_SECTIONS = {
  "Git hygiene": "aca9ec34334963bfc48aa77715f81a2b500d966e392cf1ddce80951aa8f39d42",
  "Linter and type-checker configuration":
    "cdaa2dacd9c60284ecb6a8084a607b889b1b2ac5eb38acf7a344d0a57f24ce72",
};

/** The raw text of the `## heading` section, up to the next heading; empty when it is missing. */
function section(heading: string): string {
  const start = RAW.indexOf(`## ${heading}\n`);
  if (start === -1) return "";
  const end = RAW.indexOf("\n## ", start + 1);
  return RAW.slice(start, end === -1 ? undefined : end);
}

const OPTIMIZER_DIR = "src/plugin/optimizer";

// Repository paths quoted in the doc; globs are patterns, not paths.
const QUOTED_PATHS = [
  ...AGENTS.matchAll(/`((?:src|tests|docs|benchmarks|examples|scripts)\/[^`*\s]*)`/gu),
].map(([, path]) => path ?? "");

let vitest: Vitest;

beforeAll(async () => {
  vitest = await createVitest("test", {
    watch: false,
    config: join(REPO_ROOT, "vitest.config.ts"),
  });
});

afterAll(async () => {
  await vitest.close();
});

describe("AGENTS.md", () => {
  it("names both build tsconfigs and the output of each", () => {
    expect(AGENTS).toContain("`src/ecstatic/`) to `dist/` with `tsconfig.build.json`");
    expect(AGENTS).toContain("`src/plugin/`) to `dist/plugin/` with `tsconfig.build-plugin.json`");
  });

  it("names every Vitest project the config defines", () => {
    const names = vitest.projects.map((project) => project.name);

    const missing = names.filter((name) => !AGENTS.includes(`\`${name}\``));

    expect(names).not.toHaveLength(0);
    expect(missing).toStrictEqual([]);
  });

  it("gives the golden regeneration command", () => {
    expect(AGENTS).toContain("`npx vitest run --project fixtures -u`");
  });

  it.each([
    "`src/ecstatic/`",
    "`src/plugin/`",
    "`src/ecstatic/version.ts`",
    `\`${OPTIMIZER_DIR}/\``,
    `\`${OPTIMIZER_DIR}/compiler.ts\``,
    "`facts.ts`",
    "`plan.ts`",
    "`emit/`",
    "`typescript`",
    "`tests/unit/optimizer/boundary.test.ts`",
  ])("describes the layout with %s", (quoted) => {
    expect(AGENTS).toContain(quoted);
  });

  it("quotes only repository paths that exist", () => {
    const stale = QUOTED_PATHS.filter((path) => !existsSync(join(REPO_ROOT, path)));

    expect(QUOTED_PATHS).not.toHaveLength(0);
    expect(stale).toStrictEqual([]);
  });

  it.each(["facts.ts", "plan.ts", "emit"])(
    "names %s, an optimizer module that exists",
    (module) => {
      expect(existsSync(join(REPO_ROOT, OPTIMIZER_DIR, module))).toBe(true);
    },
  );

  it("states no Go requirement", () => {
    expect(AGENTS).not.toMatch(/\bgo(?:lang)?(?![a-z])/iu);
  });

  it.each(Object.entries(PINNED_SECTIONS))("keeps the %s section as on main", (heading, hash) => {
    const text = section(heading);

    expect(text).not.toBe("");
    expect(createHash("sha256").update(text).digest("hex")).toBe(hash);
  });
});
