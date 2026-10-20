import type { Position } from "../../../src/plugin/optimizer/facts.js";

const BOM = "\uFEFF";

/** A line break as the compiler's line map ends a line: CRLF, LF, CR, LS, or PS. */
const LINE_BREAK = /\r\n|[\n\r\u2028\u2029]/g;

/**
 * Finds the `nth` (from 0) occurrence of `text` in `source` and gives its position in `file`.
 *
 * The offset counts UTF-16 code units of `source` as written, a leading byte order mark included.
 * The line counts from 1 and the column counts UTF-16 code units from 1, both read from the text
 * after the byte order mark, so they name the character an editor shows there.
 *
 * @param file - The file name the position carries.
 * @param source - The file's text as written to disk.
 * @param text - The text to find.
 * @param nth - Which occurrence to find, counting from 0.
 * @returns The position of the occurrence's first character.
 * @throws Error when `source` holds fewer than `nth + 1` occurrences of `text`.
 */
export function locate(file: string, source: string, text: string, nth = 0): Position {
  let offset = -1;
  for (let found = 0; found <= nth; found++) {
    offset = source.indexOf(text, offset + 1);
    if (offset < 0) {
      throw new Error(`source has fewer than ${nth + 1} occurrences of ${JSON.stringify(text)}`);
    }
  }
  const skipped = source.startsWith(BOM) ? BOM.length : 0;
  const before = source.slice(skipped, offset);
  const breaks = [...before.matchAll(LINE_BREAK)];
  const lineStart = Math.max(0, ...breaks.map((match) => match.index + match[0].length));
  return {
    file,
    offset,
    line: breaks.length + 1,
    column: before.length - lineStart + 1,
  };
}
