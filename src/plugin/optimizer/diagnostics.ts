/**
 * Turns the bails of a build into the diagnostics it reports. It reads plain values only, so the
 * wording never depends on the compiler.
 */

import { compareCodeUnits, DETAIL_PLACEHOLDER, type Position, reasonInfo } from "./facts.js";
import { type Bail, isReported } from "./plan.js";

/** An `INTERNAL` bail covering a whole file: analyzing the file threw, so it names no call. */
export interface FileBail {
  /** The thrown value's message. */
  readonly detail: string;
  /** The file's start. */
  readonly pos: Position;
  readonly reason: "INTERNAL";
}

/** One reported bail, located at its call, or at the start of its file for a file bail. */
export interface BailDiagnostic {
  readonly file: string;
  readonly category: "error" | "warning";
  readonly message: string;
  /** The reason's diagnostic code. */
  readonly code: number;
  /** 0-based offset of the call in the file text. */
  readonly start: number;
  /** 1-based. */
  readonly line: number;
  /** 1-based, in UTF-16 code units. */
  readonly column: number;
}

/**
 * Turns the bails a build reports into diagnostics, ordered by file name, then offset.
 *
 * Under strict, every strict and warning bail, `INTERNAL` included, is an error. Without strict,
 * warning bails are warnings, and an `INTERNAL` bail is a warning whose message starts with its
 * position (a file bail's message already names its file), so an internal failure never fails a
 * lenient build. Silent bails are never reported.
 *
 * @param bails - The bails of the build's files, in any order.
 * @param strict - Whether the build runs under strict.
 * @returns One diagnostic per reported bail.
 */
export function bailDiagnostics(
  bails: readonly (Bail | FileBail)[],
  strict: boolean,
): readonly BailDiagnostic[] {
  const sorted = bails.toSorted((a, b) => {
    const byFile = compareCodeUnits(a.pos.file, b.pos.file);
    return byFile === 0 ? a.pos.offset - b.pos.offset : byFile;
  });
  const diagnostics: BailDiagnostic[] = [];
  for (const bail of sorted) {
    const { code } = reasonInfo(bail.reason);
    if (code === undefined || !(bail.reason === "INTERNAL" || isReported(bail, strict))) {
      continue;
    }
    const { pos } = bail;
    diagnostics.push({
      file: pos.file,
      category: strict ? "error" : "warning",
      code,
      start: pos.offset,
      line: pos.line,
      column: pos.column,
      message: diagnosticMessage(bail, strict),
    });
  }
  return diagnostics;
}

/**
 * Words a reported bail's diagnostic. A lenient `INTERNAL` call bail starts with the call's
 * position; a file bail's message already names its file, and its position is only the file's
 * start.
 *
 * @param bail - Reported bail to word.
 * @param strict - Whether the build runs under strict.
 * @returns The diagnostic's message.
 */
function diagnosticMessage(bail: Bail | FileBail, strict: boolean): string {
  const message = bailMessage(bail, strict);
  if (strict || bail.reason !== "INTERNAL" || !("op" in bail)) {
    return message;
  }
  return `${bail.pos.file}:${bail.pos.line}:${bail.pos.column}: ${message}`;
}

/**
 * Words the diagnostic of one bail: what kept the call or file at runtime, why, and the reason's
 * hint when it has one.
 *
 * @param bail - Bail to word.
 * @param strict - Whether the build runs under strict, which the message names.
 * @returns The message, the bail's detail in place of its reason's placeholder.
 */
function bailMessage(bail: Bail | FileBail, strict: boolean): string {
  const { text, hint } = reasonInfo(bail.reason);
  // A replacer function keeps `$&` and its kin in a thrown message verbatim.
  const reason = text.replace(DETAIL_PLACEHOLDER, () => bail.detail ?? "");
  const kept =
    "op" in bail
      ? `ecstatic: The ${bail.op}() call cannot be optimized (${reason}). It compiles to the runtime call`
      : `ecstatic: ${bail.pos.file} could not be analyzed (${reason}). Its calls compile to the runtime calls`;
  const mode = strict ? " (strict mode)" : "";
  return hint === undefined ? `${kept}${mode}.` : `${kept}${mode}. ${hint}`;
}
