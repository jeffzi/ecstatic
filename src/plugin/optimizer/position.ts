import { skipTrivia, type Node, type SourceFile } from "typescript/ast";

import { sourceFileName } from "./compiler.js";
import type { Position } from "./facts.js";

/**
 * The position of `node`'s first token in `source`.
 *
 * The offset is read from the compiler's positions, the line and column from `source.text`. The two
 * differ in a file served with a byte order mark: `text` leaves the mark out while the compiler's
 * positions still count it, so they run one past.
 *
 * @param source - The file `node` belongs to.
 * @param node - The node to locate.
 * @returns The file's name in the platform's spelling; the offset of the node's first token, in the
 *   compiler's own unit, so it orders against other nodes' positions; and the token's 1-based line
 *   and 1-based column, in UTF-16 code units.
 */
export function nodePosition(source: SourceFile, node: Node): Position {
  const offset = firstTokenOffset(source, node);
  const { line, character } = source.getLineAndCharacterOfPosition(offset - positionShift(source));
  return {
    file: sourceFileName(source),
    offset,
    line: line + 1,
    column: character + 1,
  };
}

/**
 * How far the compiler's positions run past `source.text`: the compiler counts a byte order mark
 * that the text leaves out.
 *
 * @param source - The file.
 * @returns The number of characters of byte order mark that open the file.
 */
export function positionShift(source: SourceFile): number {
  return source.end - source.text.length;
}

/**
 * The offset of a node's first token, past its leading trivia.
 *
 * @param source - The file `node` belongs to.
 * @param node - The node.
 * @returns The offset, in the compiler's positions.
 */
export function firstTokenOffset(source: SourceFile, node: Node): number {
  const shift = positionShift(source);
  return skipTrivia(source.text, node.pos - shift) + shift;
}
