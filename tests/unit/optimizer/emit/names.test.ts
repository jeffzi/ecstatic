import { type Node, NodeFlags, type Statement } from "typescript/ast";
import {
  createBlock,
  createExpressionStatement,
  createFunctionDeclaration,
  createIdentifier,
  createLabeledStatement,
  createPropertyAccessExpression,
  createVariableDeclaration,
  createVariableDeclarationList,
  createVariableStatement,
} from "typescript/ast/factory";
import { describe, expect, it } from "vitest";

import { NameGenerator } from "../../../../src/plugin/optimizer/emit/names.js";

/** A `const` statement declaring `name`. */
function declare(name: string): Statement {
  return createVariableStatement(
    undefined,
    createVariableDeclarationList(
      [createVariableDeclaration(createIdentifier(name))],
      NodeFlags.Const,
    ),
  );
}

/** A tree whose top-level statements declare each of `names`. */
function declaring(names: readonly string[]): Node {
  return createBlock(names.map((name) => declare(name)));
}

describe("NameGenerator", () => {
  describe("when the base name is the first generated", () => {
    it.each<{ identifiers: readonly string[]; base: string; expected: string }>([
      { identifiers: ["total"], base: "storage", expected: "storage" },
      { identifiers: ["storage"], base: "storage", expected: "storage_1" },
      { identifiers: ["storage", "storage_1"], base: "storage", expected: "storage_2" },
      { identifiers: ["storage", "storage_2"], base: "storage", expected: "storage_1" },
      { identifiers: ["row_"], base: "row_", expected: "row_1" },
    ])("gives $base the name $expected past $identifiers", ({ identifiers, base, expected }) => {
      const names = new NameGenerator(declaring(identifiers));

      const name = names.unique(base);

      expect(name).toBe(expected);
    });
  });

  describe("when the identifier sits anywhere in the file", () => {
    it.each<{ where: string; root: Node }>([
      {
        where: "a nested function body",
        root: createBlock([
          createFunctionDeclaration(
            undefined,
            undefined,
            createIdentifier("scenario"),
            undefined,
            [],
            undefined,
            createBlock([createBlock([declare("x")])]),
          ),
        ]),
      },
      {
        where: "a property name",
        root: createBlock([
          createExpressionStatement(
            createPropertyAccessExpression(
              createIdentifier("position"),
              undefined,
              createIdentifier("x"),
              NodeFlags.None,
            ),
          ),
        ]),
      },
      {
        where: "a label",
        root: createBlock([createLabeledStatement(createIdentifier("x"), createBlock([]))]),
      },
    ])("passes over the identifier in $where", ({ root }) => {
      const names = new NameGenerator(root);

      const name = names.unique("x");

      expect(name).toBe("x_1");
    });
  });

  describe("when the base name was generated before", () => {
    it("passes over every name generated so far and every identifier present", () => {
      const names = new NameGenerator(declaring(["i_1"]));

      const generated = [names.unique("i"), names.unique("i"), names.unique("i")];

      expect(generated).toStrictEqual(["i", "i_2", "i_3"]);
    });
  });
});
