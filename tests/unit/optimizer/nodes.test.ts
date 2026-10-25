import { TokenFlags } from "typescript/ast";
import { createIdentifier, createStringLiteral } from "typescript/ast/factory";
import { isIdentifier } from "typescript/ast/is";
import { describe, expect, it } from "vitest";

import type { NodeID } from "../../../src/plugin/optimizer/facts.js";
import { NodeTable, tableNode } from "../../../src/plugin/optimizer/nodes.js";

describe("NodeTable", () => {
  describe("when a node is registered again", () => {
    it("reuses its ID without consuming a new one", () => {
      const table = new NodeTable();
      const first = createIdentifier("banana");
      const second = createIdentifier("banana");
      const third = createIdentifier("banana");

      const ids = [first, second, first, third].map((node) => table.register(node));

      expect(ids).toStrictEqual([0, 1, 0, 2]);
    });
  });

  describe("when the ID is registered", () => {
    it("returns its node", () => {
      const table = new NodeTable();
      const first = createIdentifier("banana");
      const second = createIdentifier("banana");
      table.register(first);
      const id = table.register(second);

      const found = table.node(id);

      expect(found).toBe(second);
    });
  });

  describe("when the ID is unknown", () => {
    it.each<{ name: string; id: NodeID }>([
      { name: "negative", id: -1 },
      { name: "one past the last registered", id: 1 },
    ])("reports $name as not found", ({ id }) => {
      const table = new NodeTable();
      table.register(createIdentifier("banana"));

      const found = table.node(id);

      expect(found).toBeUndefined();
    });
  });
});

describe("tableNode", () => {
  describe("when the ID holds a node of the expected kind", () => {
    it("returns it", () => {
      const table = new NodeTable();
      const node = createIdentifier("banana");
      const id = table.register(node);

      const found = tableNode(table, id, "identifier", isIdentifier);

      expect(found).toBe(node);
    });
  });

  describe("when the lookup fails", () => {
    it.each<{ name: string; id: NodeID }>([
      { name: "an unknown ID", id: 7 },
      { name: "an ID holding a node of another kind", id: 0 },
    ])("throws naming what was looked up and the node ID: $name", ({ id }) => {
      const table = new NodeTable();
      table.register(createStringLiteral("apple", TokenFlags.None));

      const lookup = () => tableNode(table, id, "identifier", isIdentifier);

      expect(lookup).toThrow(new RegExp(String.raw`^(?=.*\bidentifier\b)(?=.*\b${id}\b)`, "s"));
    });
  });
});
