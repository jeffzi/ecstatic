/**
 * Prints a rewritten file: the source text with the preamble and each inlined loop spliced in, and a
 * version 3 source map from it back to the source.
 */

import { basename } from "node:path";

import {
  isExpressionStatement,
  isStringLiteral,
  type Node,
  type SourceFile,
  SyntaxKind,
} from "typescript/ast";
import { getShebang, skipTrivia } from "typescript/ast/scanner";

import { sourceFileName } from "../compiler.js";
import { firstTokenOffset, positionShift } from "../position.js";
import type { Session } from "../session.js";

/** A node printed in place of a node of the source. */
export interface Replacement {
  /** The statement the loop replaces, or the call when the call is an arrow function's body. */
  readonly target: Node;
  readonly node: Node;
}

/** A version 3 source map carrying its source text inline. */
export interface SourceMapV3 {
  readonly version: 3;
  readonly file: string;
  readonly sourceRoot: string;
  readonly sources: string[];
  readonly names: string[];
  readonly sourcesContent: string[];
  readonly mappings: string;
}

/** A rewritten file's text and its source map. */
export interface PrintedFile {
  readonly text: string;
  readonly map: SourceMapV3;
}

/** Printed text that replaces the file's text from `start` to `end`. */
interface Splice {
  readonly text: string;
  readonly start: number;
  readonly end: number;
  /** Whether the splice's lines map to the source position at `start`; the preamble maps nowhere. */
  readonly mapped: boolean;
}

const BOM = "\uFEFF";

const INDENTATION = /^[ \t]*/u;

/** The zero-width point after each `\n`, where `split` cuts a text into lines that keep it. */
const LINE_END = /(?<=\n)/u;

/**
 * Prints `source` with `preamble` and each of `replacements` spliced in.
 *
 * Every character outside the replaced nodes and the preamble is the source's own, a byte order
 * mark included. Each replacement is spliced over its target from the target's first token, so the
 * comments around it stay, and no comment inside the target is printed. Its continuation lines take
 * the indentation of the line its target starts on, except lines that continue a string literal, a
 * template literal, or JSX text, whose value the prefix would change. The preamble goes after the
 * directive prologue, or else after the shebang, or else at the start of the file. Every printed
 * line ends with the line break that ends the source's first line.
 *
 * The map takes every token copied from the source to its own position, and the first token of
 * every line of a replacement to the first token of its target, in 0-based lines and UTF-16
 * columns; the preamble maps nowhere.
 *
 * @param session - The session whose compiler prints the nodes.
 * @param source - The file to rewrite.
 * @param preamble - Statements added once to the file; ignored when `replacements` is empty.
 * @param replacements - The nodes to splice in, whose targets do not overlap.
 * @returns The rewritten text, which is the source's when `replacements` is empty, and its map.
 * @throws When two targets overlap, naming the file, or the session cannot print or parse.
 */
export async function printSpliced(
  session: Session,
  source: SourceFile,
  preamble: readonly Node[],
  replacements: readonly Replacement[],
): Promise<PrintedFile> {
  const shift = positionShift(source);
  const text = BOM.repeat(shift) + source.text;
  const splices =
    replacements.length === 0 ? [] : await spliced(session, source, preamble, replacements);
  const out = new SplicedText(text, shift);
  for (const splice of splices) {
    out.copySource(splice.start);
    out.insert(splice.text, splice.mapped);
    out.skipSource(splice.end);
  }
  out.copySource(text.length);
  const file = basename(sourceFileName(source));
  return { text: out.text, map: out.sourceMap(file, source.text) };
}

/**
 * The preamble and the replacements as splices into the file's text, in source order, at offsets
 * in the compiler's positions.
 *
 * @param session - The session whose compiler prints the nodes.
 * @param source - The file to rewrite.
 * @param preamble - Statements added once to the file.
 * @param replacements - The nodes to splice in.
 * @returns The splices, the preamble's first.
 * @throws When two targets overlap, or the session cannot print or parse.
 */
async function spliced(
  session: Session,
  source: SourceFile,
  preamble: readonly Node[],
  replacements: readonly Replacement[],
): Promise<Splice[]> {
  const sorted = replacements.toSorted((a, b) => a.target.pos - b.target.pos);
  const [preambleLines, printedLoops] = await Promise.all([
    Promise.all(preamble.map(async (statement) => await session.print(statement))),
    Promise.all(
      sorted.map(async ({ target, node }) => ({ target, printed: await session.print(node) })),
    ),
  ]);
  const newline = sourceNewline(source.text);
  const shift = positionShift(source);
  const at = preambleOffset(source, shift);
  const joined = preambleLines.join(newline);
  const preambleSplice: Splice = {
    text: at === shift ? joined + newline : newline + joined,
    start: at,
    end: at,
    mapped: false,
  };
  const loops = printedLoops.map(({ target, printed }) => ({
    start: firstTokenOffset(source, target),
    end: target.end,
    printed,
  }));
  const fileName = sourceFileName(source);
  assertDisjoint(fileName, at, loops);
  const loopSplices = await Promise.all(
    loops.map(async ({ start, end, printed: loop }) => {
      const indentation = lineIndentation(source.text, start - shift);
      const text = withNewline(await indent(session, fileName, loop, indentation), newline);
      return { text, start, end, mapped: true };
    }),
  );
  return [preambleSplice, ...loopSplices];
}

/**
 * Checks that no loop starts before the splice ahead of it ends.
 *
 * @param fileName - The file, named in the error.
 * @param preambleEnd - Where the preamble's splice ends.
 * @param loops - The loops' ranges, in source order.
 * @throws When a loop starts before the previous splice ends.
 */
function assertDisjoint(
  fileName: string,
  preambleEnd: number,
  loops: readonly { start: number; end: number }[],
): void {
  let previousEnd = preambleEnd;
  for (const { start, end } of loops) {
    if (start < previousEnd) {
      throw new Error(
        `${fileName}: the loop at offset ${start} overlaps the splice ending at offset ${previousEnd}`,
      );
    }
    previousEnd = end;
  }
}

/**
 * The run of spaces and tabs that opens the line of `text` holding `offset`.
 *
 * @param text - The source text.
 * @param offset - An offset in `text`.
 * @returns The indentation, empty when the line opens with neither.
 */
function lineIndentation(text: string, offset: number): string {
  const before = text.slice(0, offset);
  const line = before.slice(Math.max(before.lastIndexOf("\n"), before.lastIndexOf("\r")) + 1);
  return INDENTATION.exec(line)?.[0] ?? "";
}

/**
 * `printed`, a loop as the printer wrote it, with `indentation` opening every line but the first,
 * an empty one, and one that continues a string literal, a template literal, or JSX text, whose
 * value the prefix would change.
 *
 * @param session - The session whose compiler parses `printed` to find its literals.
 * @param fileName - The name of the file the loop goes into, which sets the script kind.
 * @param printed - The printed loop, its lines ending with `\n`.
 * @param indentation - The prefix of each continuation line.
 * @returns The indented text.
 * @throws When the session cannot parse.
 */
async function indent(
  session: Session,
  fileName: string,
  printed: string,
  indentation: string,
): Promise<string> {
  if (indentation === "") return printed;
  const literals = literalRanges(await session.parseText(fileName, printed));
  let indented = "";
  let at = 0;
  for (const line of printed.split(LINE_END)) {
    const continued = literals.some(({ pos, end }) => pos < at && at <= end);
    if (at > 0 && line !== "\n" && !continued) indented += indentation;
    indented += line;
    at += line.length;
  }
  return indented;
}

/** The kinds of the nodes whose text a line break can continue. */
const LITERAL_KINDS: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.StringLiteral,
  SyntaxKind.NoSubstitutionTemplateLiteral,
  SyntaxKind.TemplateHead,
  SyntaxKind.TemplateMiddle,
  SyntaxKind.TemplateTail,
  SyntaxKind.JsxText,
]);

/**
 * The range, from its first token to its end, of every string literal, template literal part, and
 * JSX text in `file`.
 *
 * @param file - The parsed text.
 * @returns The ranges, as offsets in the file's text.
 */
function literalRanges(file: SourceFile): { pos: number; end: number }[] {
  const ranges: { pos: number; end: number }[] = [];
  const visit = (node: Node): void => {
    if (LITERAL_KINDS.has(node.kind)) {
      ranges.push({ pos: skipTrivia(file.text, node.pos), end: node.end });
    }
    node.forEachChild(visit);
  };
  file.forEachChild(visit);
  return ranges;
}

/**
 * The line break that ends the first line of `text`.
 *
 * @param text - The source text.
 * @returns `\r\n` or `\n`, which a text of one line gets.
 */
function sourceNewline(text: string): string {
  const i = text.indexOf("\n");
  return i > 0 && text[i - 1] === "\r" ? "\r\n" : "\n";
}

/**
 * `printed`, whose lines the printer ends with `\n`, with every line ending with `newline`. A
 * `\r\n` already in `printed`, copied from a template literal, becomes `newline` too rather than
 * `\r` followed by `newline`, an extra line break the literal's value would gain.
 *
 * @param printed - Text as the printer wrote it.
 * @param newline - The line break of the source.
 * @returns The text with its line breaks replaced.
 */
function withNewline(printed: string, newline: string): string {
  if (newline === "\n") return printed;
  return printed.replaceAll("\r\n", "\n").replaceAll("\n", newline);
}

/**
 * Where the preamble goes: after the directive prologue, or else after the shebang, or else at the
 * start of the file, past any byte order mark.
 *
 * @param source - The file to rewrite.
 * @param shift - How far the compiler's positions run past `source.text`.
 * @returns The offset in the compiler's positions.
 */
function preambleOffset(source: SourceFile, shift: number): number {
  let prologueEnd: number | undefined;
  for (const statement of source.statements) {
    if (!isExpressionStatement(statement) || !isStringLiteral(statement.expression)) break;
    prologueEnd = statement.end;
  }
  return prologueEnd ?? shift + (getShebang(source.text)?.length ?? 0);
}

/** A 0-based line and a 0-based column in UTF-16 code units, the units of a source map. */
class TextPosition {
  line = 0;
  column = 0;

  /**
   * Moves past `char`, the character at `index` of `text`. A line ends at `\n`, at `\r` not
   * followed by `\n`, at U+2028, or at U+2029, as the compiler's line map ends one.
   *
   * @param char - The character, one code point.
   * @param text - The text holding it.
   * @param index - Where `char` starts in `text`.
   */
  advance(char: string, text: string, index: number): void {
    if (
      char === "\n" ||
      char === "\u2028" ||
      char === "\u2029" ||
      (char === "\r" && text[index + 1] !== "\n")
    ) {
      this.line++;
      this.column = 0;
      return;
    }
    this.column += char.length;
  }
}

const SPACE = /\s/u;
const WORD = /[\p{L}\p{N}_$]/u;

/**
 * Whether `char` can be part of an identifier, a keyword, or a number.
 *
 * @param char - One code point.
 * @returns True for a letter, a digit, `_`, or `$`.
 */
function isWord(char: string): boolean {
  return WORD.test(char);
}

/** A source map segment's fields: generated column, source index, original line and column. */
type Segment = [number, number, number, number];

const BASE64_DIGITS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/**
 * `value` as a base64 VLQ: the sign in the lowest bit, then five bits per digit, lowest first.
 *
 * @param value - The integer to encode.
 * @returns The VLQ digits.
 */
function vlq(value: number): string {
  let rest = value < 0 ? (-value << 1) | 1 : value << 1;
  let digits = "";
  do {
    let digit = rest & 31;
    rest >>>= 5;
    if (rest > 0) digit |= 32;
    // `digit` is at most 63, so it always indexes the 64-digit alphabet.
    digits += BASE64_DIGITS.charAt(digit);
  } while (rest > 0);
  return digits;
}

/**
 * The text of a rewritten file and the mappings of its source map, accumulated as the source is
 * copied, skipped, and spliced into, in order.
 */
class SplicedText {
  text = "";
  readonly #source: string;
  #mappings = "";
  /** Where `text` ends. */
  readonly #generated = new TextPosition();
  /** Where the source is read up to: at `#at`. */
  readonly #original = new TextPosition();
  #at: number;
  /** The fields of the last segment written, which the next one encodes relative to. */
  #segment: Segment = [0, 0, 0, 0];
  /** The generated line the mappings have reached. */
  #segmentLine = 0;
  #segmentOnLine = false;

  /**
   * Starts at the start of `source`, its first `bom` characters, a byte order mark, copied without
   * advancing either position, as the compiler's lines and columns leave the mark out.
   *
   * @param source - The text to rewrite.
   * @param bom - How many characters of byte order mark open `source`.
   */
  constructor(source: string, bom: number) {
    this.#source = source;
    this.text = source.slice(0, bom);
    this.#at = bom;
  }

  /**
   * Copies the source up to offset `to`, mapping each token it starts to its own position.
   *
   * @param to - Offset in the source to copy up to.
   */
  copySource(to: number): void {
    let previous = " ";
    let index = this.#at;
    for (const char of this.#source.slice(this.#at, to)) {
      if (!SPACE.test(char) && (SPACE.test(previous) || isWord(previous) !== isWord(char))) {
        this.#addSegment();
      }
      this.#generated.advance(char, this.#source, index);
      this.#original.advance(char, this.#source, index);
      previous = char;
      index += char.length;
    }
    this.text += this.#source.slice(this.#at, to);
    this.#at = to;
  }

  /**
   * Moves past the source up to offset `to` without copying it.
   *
   * @param to - Offset in the source to skip to.
   */
  skipSource(to: number): void {
    let index = this.#at;
    for (const char of this.#source.slice(this.#at, to)) {
      this.#original.advance(char, this.#source, index);
      index += char.length;
    }
    this.#at = to;
  }

  /**
   * Appends `inserted`, mapping the first token of each of its lines to the source position read
   * up to when `mapped`.
   *
   * @param inserted - The text to append.
   * @param mapped - Whether its lines map to the source.
   */
  insert(inserted: string, mapped: boolean): void {
    let pending = mapped;
    let index = 0;
    for (const char of inserted) {
      if (pending && !SPACE.test(char)) {
        this.#addSegment();
        pending = false;
      }
      const line = this.#generated.line;
      this.#generated.advance(char, inserted, index);
      pending ||= mapped && this.#generated.line !== line;
      index += char.length;
    }
    this.text += inserted;
  }

  /**
   * The version 3 source map of the text.
   *
   * @param file - The name of the generated file and of its source.
   * @param content - The source text the map carries inline.
   * @returns The source map.
   */
  sourceMap(file: string, content: string): SourceMapV3 {
    return {
      version: 3,
      file,
      sourceRoot: "",
      sources: [file],
      names: [],
      sourcesContent: [content],
      mappings: this.#mappings,
    };
  }

  /** Maps the generated position to the original one, unless a segment already starts there. */
  #addSegment(): void {
    const generated = this.#generated;
    if (
      this.#segmentOnLine &&
      generated.line === this.#segmentLine &&
      generated.column === this.#segment[0]
    ) {
      return;
    }
    while (this.#segmentLine < generated.line) {
      this.#mappings += ";";
      this.#segmentLine++;
      this.#segment[0] = 0;
      this.#segmentOnLine = false;
    }
    if (this.#segmentOnLine) this.#mappings += ",";
    const fields: Segment = [generated.column, 0, this.#original.line, this.#original.column];
    const previous = this.#segment;
    this.#mappings +=
      vlq(fields[0] - previous[0]) +
      vlq(fields[1] - previous[1]) +
      vlq(fields[2] - previous[2]) +
      vlq(fields[3] - previous[3]);
    this.#segment = fields;
    this.#segmentOnLine = true;
  }
}
