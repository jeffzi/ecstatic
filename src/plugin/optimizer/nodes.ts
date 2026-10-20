/**
 * Maps the {@link NodeID}s analysis reports back to AST nodes, so the plan can name nodes by ID.
 * Reads nodes only; never the checker.
 */

import type { Node } from "typescript/ast";

import type { NodeID } from "./facts.js";

/** Assigns {@link NodeID}s to the nodes of one source file. */
export class NodeTable {
  readonly #ids = new Map<Node, NodeID>();
  readonly #nodes: Node[] = [];

  /**
   * Returns `node`'s ID, assigning the next one, dense from 0 in registration order, when `node`
   * is new to the table.
   *
   * @param node - The node to identify.
   * @returns The ID `node` is registered under.
   */
  register(node: Node): NodeID {
    const known = this.#ids.get(node);
    if (known !== undefined) return known;
    const id = this.#nodes.length;
    this.#ids.set(node, id);
    this.#nodes.push(node);
    return id;
  }

  /**
   * Reads back a node by the ID {@link NodeTable.register} gave it.
   *
   * @param id - The ID to look up.
   * @returns The node, or `undefined` when no node has `id`.
   */
  node(id: NodeID): Node | undefined {
    return this.#nodes[id];
  }
}
