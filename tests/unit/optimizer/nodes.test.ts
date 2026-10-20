import { createIdentifier } from "typescript/ast/factory";
import { describe, expect, it } from "vitest";

import type { NodeID } from "../../../src/plugin/optimizer/facts.js";
import { NodeTable } from "../../../src/plugin/optimizer/nodes.js";

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
