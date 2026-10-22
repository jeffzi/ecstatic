import { type FunctionExpression, type Node, SyntaxKind } from "typescript/ast";
import { isCallExpression, isFunctionExpression, isIdentifier } from "typescript/ast/is";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { functionLocalUses } from "../../../../src/plugin/optimizer/analysis/function-local.js";
import type { Rule } from "../../../../src/plugin/optimizer/emit/catalog.js";
import { closeProject, projectPath, SPAWN_TIMEOUT_MS } from "../project.js";
import { CASE_PRELUDE, EmitProject } from "./emit-project.js";

let project: EmitProject;

beforeAll(async () => {
  project = await EmitProject.open();
}, SPAWN_TIMEOUT_MS);

afterAll(() => closeProject(project.session));

/** The rules a callback's own `this` and `arguments` reads apply. */
const OWN_THIS_RULES: ReadonlySet<Rule> = new Set(["this", "arguments"]);

/**
 * A method that passes `body` to one each call as an arrow callback, which the plan rewrites in place, and to
 * a second as a function-expression callback, which analysis reads for its own `this` and
 * `arguments`.
 */
function ownThisSource(body: string): string {
  return `declare function tag(value: unknown): (target: unknown, key: unknown, index: number) => void;
export class Walker {
    readonly tag = "walker";
    walk(...extra: number[]): unknown[] {
        const seen: unknown[] = [extra];
        each(register(createWorld(), Mover), (e) => {
            ${body}
        });
        each(register(createWorld(), Mover), function (this: Walker, e) {
            ${body}
        });
        return seen;
    }
}
`;
}

/** The function-expression callback `source` passes to an each call. */
function functionCallback(source: Node): FunctionExpression {
  let found: FunctionExpression | undefined;
  source.forEachChild(function visit(child: Node): void {
    if (found !== undefined) return;
    if (
      isCallExpression(child) &&
      isIdentifier(child.expression) &&
      child.expression.text === "each"
    ) {
      const callback = child.arguments.at(-1);
      if (callback !== undefined && isFunctionExpression(callback)) {
        found = callback;
        return;
      }
    }
    child.forEachChild(visit);
  });
  if (found === undefined) throw new Error("the case passes no function-expression callback");
  return found;
}

/** The own-`this` rule a function-local use stands for, or `undefined` for any other use. */
function ownThisRule(use: Node): Rule | undefined {
  if (use.kind === SyntaxKind.ThisKeyword) return "this";
  if (isIdentifier(use) && use.text === "arguments") return "arguments";
  return undefined;
}

describe("own this and arguments", () => {
  it.each<{ name: string; body: string; expected: readonly Rule[] }>([
    {
      name: "real this and arguments reads",
      body: "seen.push(this.tag, arguments.length, e.Position.x);",
      expected: ["this", "arguments"],
    },
    {
      name: "this in a method-parameter decorator",
      body: [
        "seen.push(e.Position.x, class {",
        "    // @ts-expect-error -- a parameter decorator needs experimentalDecorators; it still evaluates in the callback",
        "    method(@tag(this) held: unknown): void {}",
        "});",
      ].join("\n            "),
      expected: ["this"],
    },
    {
      name: "arguments as a property name",
      body: "seen.push({ arguments: 1 }, e.Position.x);",
      expected: [],
    },
  ])(
    "agrees with analysis on the callback's own this and arguments for $name",
    async ({ body, expected }) => {
      const planned = await project.planned(CASE_PRELUDE + ownThisSource(body));
      const view = await project.session.update();
      const source = await view.sourceFile(projectPath(project.root, planned.rel));
      const uses = await functionLocalUses(view.checker, functionCallback(source));

      const { applied } = await project.emit(planned);

      expect({
        analysis: [...new Set(uses.map(ownThisRule))].filter((rule) => rule !== undefined),
        emit: applied.filter((rule) => OWN_THIS_RULES.has(rule)),
      }).toStrictEqual({ analysis: expected, emit: expected });
    },
  );
});
