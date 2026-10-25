import { describe, expect, it } from "vitest";

import {
  type BailDiagnostic,
  bailDiagnostics,
  type FileBail,
} from "../../../src/plugin/optimizer/diagnostics.js";
import type { Op, Position, Reason } from "../../../src/plugin/optimizer/facts.js";
import type { Bail } from "../../../src/plugin/optimizer/plan.js";

/** The position in `file` at `offset`, on `line` and `column`. */
function at(file: string, offset: number, line: number, column: number): Position {
  return { file, offset, line, column };
}

/** The bail of the `op` call at `pos` for `reason`. */
function bailAt(op: Op, reason: Reason, pos: Position): Bail {
  return { call: pos.offset, op, reason, pos };
}

/** The INTERNAL bail of the each call at `pos`, carrying `detail`. */
function internalAt(pos: Position, detail: string): Bail {
  return { ...bailAt("each", "INTERNAL", pos), detail };
}

const MAIN_START = at("main.ts", 0, 1, 1);

/** The file-level INTERNAL bail of main.ts, carrying `detail`. */
function fileBail(detail: string): FileBail {
  return { reason: "INTERNAL", pos: MAIN_START, detail };
}

/** The diagnostic `category` reports at `pos` with `code` and `message`. */
function diagnosticAt(
  pos: Position,
  category: BailDiagnostic["category"],
  code: number,
  message: string,
): BailDiagnostic {
  return {
    file: pos.file,
    category,
    code,
    start: pos.offset,
    line: pos.line,
    column: pos.column,
    message,
  };
}

const ASYNC_HINT =
  "Views are valid only until the callback returns; collect ids and await between passes.";

/** The message of the CALLBACK_ASYNC bail of an each call, with `suffix` after the runtime call. */
function asyncMessage(suffix: string): string {
  return (
    "ecstatic: The each() call cannot be optimized (the callback is async). It compiles to the " +
    `runtime call${suffix}. ${ASYNC_HINT}`
  );
}

/** The message of an INTERNAL bail of an each call for `detail`, with `suffix`. */
function internalMessage(detail: string, suffix: string): string {
  return (
    `ecstatic: The each() call cannot be optimized (internal error (\`${detail}\`); please report ` +
    `it). It compiles to the runtime call${suffix}.`
  );
}

/** The message of the NDEBUG_BOUND bail of an each call, with `suffix` after the runtime call. */
function ndebugBoundMessage(suffix: string): string {
  return (
    "ecstatic: The each() call cannot be optimized (`NDEBUG` is declared in scope at the call). " +
    `It compiles to the runtime call${suffix}. Rename the declaration; the optimized loop's debug ` +
    "check reads the global `NDEBUG`."
  );
}

describe("bailDiagnostics", () => {
  const shape = at("main.ts", 14, 3, 5);
  const storages = at("main.ts", 41, 5, 9);
  const async = at("main.ts", 68, 7, 13);
  const notStatement = at("main.ts", 90, 9, 3);
  const internal = at("main.ts", 117, 11, 4);
  const bails: readonly Bail[] = [
    bailAt("each", "SHAPE_UNRESOLVED", shape),
    bailAt("query", "STORAGES_DYNAMIC", storages),
    bailAt("each", "CALLBACK_ASYNC", async),
    bailAt("has", "NOT_STATEMENT", notStatement),
    internalAt(internal, "nil storage"),
  ];

  describe("when strict", () => {
    it("reports strict, warning, and internal bails as errors, and never silent ones", () => {
      const diagnostics = bailDiagnostics(bails, true);

      expect(diagnostics).toStrictEqual([
        diagnosticAt(
          shape,
          "error",
          99_910,
          "ecstatic: The each() call cannot be optimized (the storage's archetype shape is not " +
            "known statically). It compiles to the runtime call (strict mode). Type the storage " +
            "as `Storage<typeof X>` or `Storage<X>`.",
        ),
        diagnosticAt(
          storages,
          "error",
          99_912,
          "ecstatic: The query() call cannot be optimized (the storages argument is not an array " +
            "literal of typed storages). It compiles to the runtime call (strict mode).",
        ),
        diagnosticAt(async, "error", 99_915, asyncMessage(" (strict mode)")),
        diagnosticAt(internal, "error", 99_920, internalMessage("nil storage", " (strict mode)")),
      ]);
    });

    it("substitutes a view escape's detail into its reason", () => {
      const escape = at("main.ts", 230, 8, 1);
      const bail: Bail = {
        ...bailAt("each", "VIEW_ESCAPES", escape),
        detail: "line 10, column 8: the view as a value",
      };

      const diagnostics = bailDiagnostics([bail], true);

      expect(diagnostics).toStrictEqual([
        diagnosticAt(
          escape,
          "error",
          99_918,
          "ecstatic: The each() call cannot be optimized (the view `e` is used as a value " +
            "(`line 10, column 8: the view as a value`)). It compiles to the runtime call " +
            "(strict mode). Read fields on `e`, or keep `e.id`.",
        ),
      ]);
    });

    it("keeps replacement patterns in an internal detail verbatim", () => {
      const detail = "cannot read $& of $' or $1";

      const diagnostics = bailDiagnostics([internalAt(internal, detail)], true);

      expect(diagnostics.map((d) => d.message)).toStrictEqual([
        internalMessage(detail, " (strict mode)"),
      ]);
    });

    it("reports a file bail as an error naming the file", () => {
      const diagnostics = bailDiagnostics([fileBail("nil table")], true);

      expect(diagnostics).toStrictEqual([
        diagnosticAt(
          MAIN_START,
          "error",
          99_920,
          "ecstatic: main.ts could not be analyzed (internal error (`nil table`); please report " +
            "it). Its calls compile to the runtime calls (strict mode).",
        ),
      ]);
    });
  });

  describe("when lenient", () => {
    it("reports the warning bail and the internal bail as warnings, the internal one naming its position", () => {
      const diagnostics = bailDiagnostics(bails, false);

      expect(diagnostics).toStrictEqual([
        diagnosticAt(async, "warning", 99_915, asyncMessage("")),
        diagnosticAt(
          internal,
          "warning",
          99_920,
          `main.ts:11:4: ${internalMessage("nil storage", "")}`,
        ),
      ]);
    });

    it("reports a file bail as a warning naming only the file", () => {
      const diagnostics = bailDiagnostics([fileBail("nil table")], false);

      expect(diagnostics).toStrictEqual([
        diagnosticAt(
          MAIN_START,
          "warning",
          99_920,
          "ecstatic: main.ts could not be analyzed (internal error (`nil table`); please report " +
            "it). Its calls compile to the runtime calls.",
        ),
      ]);
    });
  });

  describe("when NDEBUG is declared in scope at the call", () => {
    const bound = at("main.ts", 52, 6, 3);

    it.each<{
      mode: string;
      strict: boolean;
      category: BailDiagnostic["category"];
      suffix: string;
    }>([
      { mode: "strict", strict: true, category: "error", suffix: " (strict mode)" },
      { mode: "lenient", strict: false, category: "warning", suffix: "" },
    ])("reports it as $category when $mode", ({ strict, category, suffix }) => {
      const diagnostics = bailDiagnostics([bailAt("each", "NDEBUG_BOUND", bound)], strict);

      expect(diagnostics).toStrictEqual([
        diagnosticAt(bound, category, 99_921, ndebugBoundMessage(suffix)),
      ]);
    });
  });

  describe("when bails are out of order", () => {
    it("orders them by file name in UTF-16 code unit order, then offset", () => {
      const aFirstLine = at("a.ts", 12, 1, 13);
      const aThirdLine = at("a.ts", 40, 3, 5);
      const bLineStart = at("B.ts", 25, 2, 4);
      const bLineEnd = at("B.ts", 30, 2, 9);
      const unordered = [bLineEnd, aThirdLine, bLineStart, aFirstLine].map((pos) =>
        bailAt("each", "CALLBACK_ASYNC", pos),
      );

      const diagnostics = bailDiagnostics(unordered, false);

      expect(diagnostics.map(({ file, start }) => ({ file, start }))).toStrictEqual([
        { file: "B.ts", start: 25 },
        { file: "B.ts", start: 30 },
        { file: "a.ts", start: 12 },
        { file: "a.ts", start: 40 },
      ]);
    });
  });
});
