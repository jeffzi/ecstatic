import { skipTrivia, type Node, type SourceFile } from "typescript/ast";

import type { Position } from "./facts.js";

/**
 * The position of `node`'s first token in `source`.
 *
 * The offset is in the compiler's own unit, so it orders against other nodes' positions. The line
 * and column are read from `source.text`. The two differ in a file served with a byte order mark:
 * `text` leaves the mark out while the compiler's positions still count it, so they run one past.
 *
 * @param source - The file `node` belongs to.
 * @param node - The node to locate.
 * @returns The 1-based line and the 1-based column, in UTF-16 code units, of the node's first token.
 */
export function nodePosition(source: SourceFile, node: Node): Position {
  const shift = source.end - source.text.length;
  const start = skipTrivia(source.text, node.pos - shift);
  const { line, character } = source.getLineAndCharacterOfPosition(start);
  return { file: source.fileName, offset: start + shift, line: line + 1, column: character + 1 };
}
