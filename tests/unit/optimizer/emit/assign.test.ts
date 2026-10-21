import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Rule } from "../../../../src/plugin/optimizer/emit/catalog.js";
import { createRewriter } from "../../../../src/plugin/optimizer/rewrite.js";
import { closeProject, projectPath, SPAWN_TIMEOUT_MS } from "../project.js";
import { CASE_PRELUDE, EmitProject } from "./emit-project.js";

/** What the error of an update lowered on a boolean field names: the component, the field, and why. */
const BOOLEAN_UPDATE = /\bFlags\b.*\bon\b.*\bboolean\b/u;

let project: EmitProject;

beforeAll(async () => {
  project = await EmitProject.open();
}, SPAWN_TIMEOUT_MS);

afterAll(() => closeProject(project.session));

describe("EmitFile", () => {
  describe("inline", () => {
    it("keeps the runtime call as an INTERNAL bail naming the component and field when an update use names a boolean field", async () => {
      const planned = await project.planned(`${CASE_PRELUDE}export function scenario(): void {
    const { storage } = guarded();
    each(storage, (e) => {
        e.Position.x++;
    });
}
`);
      const view = await project.session.update();
      const rewriter = createRewriter(project.session, {
        inline: (file, inlining, uses) => {
          file.inline(
            inlining,
            uses.map((use) =>
              use.kind === "field-update" ? { ...use, comp: "Flags", field: "on" } : use,
            ),
          );
        },
      });

      const rewritten = await rewriter.rewrite(view, projectPath(project.root, planned.rel));

      expect(rewritten.output).toBeUndefined();
      expect(rewritten.bails).toStrictEqual([
        expect.objectContaining({
          reason: "INTERNAL",
          detail: expect.stringMatching(BOOLEAN_UPDATE),
        }),
      ]);
    });
  });
  describe("applied", () => {
    it.each<{
      name: string;
      body: string;
      storage?: "guarded" | "marked";
      expected: readonly Rule[];
      absent: readonly Rule[];
    }>([
      {
        name: "a compound write to a required number field whose value is unused",
        body: "e.Position.x += 1;",
        expected: ["write-required-field"],
        absent: ["write-optional-field", "write-boolean-field", "boolean-assignment-value"],
      },
      {
        name: "a logical write to a required number field whose value is used",
        body: "seen.push((e.Position.x ||= 1));",
        expected: ["write-required-field"],
        absent: ["write-optional-field", "write-boolean-field", "boolean-assignment-value"],
      },
      {
        name: "a compound write to an optional number field whose value is used",
        body: "if (e.Shield) seen.push((e.Shield.hp -= 1));",
        expected: ["write-optional-field"],
        absent: ["write-required-field", "write-boolean-field", "boolean-assignment-value"],
      },
      {
        name: "a logical write to a required boolean field whose value is unused",
        body: "e.Flags.on &&= false;",
        expected: ["write-required-field", "write-boolean-field"],
        absent: ["write-optional-field", "boolean-assignment-value"],
      },
      {
        name: "a logical write to a required boolean field whose value is used",
        body: "seen.push((e.Flags.on ||= true));",
        expected: ["write-required-field", "write-boolean-field", "boolean-assignment-value"],
        absent: ["write-optional-field"],
      },
      {
        name: "a plain write to an optional boolean field whose value is unused",
        body: "if (e.Shield) e.Shield.up = false;",
        expected: ["write-optional-field", "write-boolean-field"],
        absent: ["write-required-field", "boolean-assignment-value"],
      },
      {
        name: "a nullish write to an optional boolean field whose value is used",
        body: "if (e.Shield) seen.push((e.Shield.up ??= true));",
        expected: ["write-optional-field", "write-boolean-field", "boolean-assignment-value"],
        absent: ["write-required-field"],
      },
      {
        name: "a nullish write to a plain field",
        body: "if (e.Mark) e.Mark.first ??= 1;",
        storage: "marked",
        expected: ["write-optional-field"],
        absent: ["write-required-field", "write-boolean-field", "boolean-assignment-value"],
      },
    ])(
      "records the rule notes of $name",
      async ({ body, storage = "guarded", expected, absent }) => {
        const source = `${CASE_PRELUDE}export const seen: unknown[] = [];
const { storage } = ${storage}();
each(storage, (e) => {
    ${body}
});
`;

        const { applied } = await project.rewrite(source);

        expect(applied).toStrictEqual(expect.arrayContaining([...expected]));
        expect(applied.filter((rule) => absent.includes(rule))).toStrictEqual([]);
      },
    );
  });
});
