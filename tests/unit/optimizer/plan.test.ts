import { describe, expect, it } from "vitest";

import type {
  ArchShape,
  Callback,
  EscapeKind,
  NodeID,
  Op,
  Position,
  Reason,
  Return,
  Site,
  ViewEscape,
} from "../../../src/plugin/optimizer/facts.js";
import {
  type Bail,
  type EachInlining,
  isReported,
  type Mode,
  plan,
  type PlanResult,
} from "../../../src/plugin/optimizer/plan.js";

/** The position of a call starting at `offset` on the first line of main.ts. */
function at(offset: number): Position {
  return { file: "main.ts", offset, line: 1, column: offset + 1 };
}

/** An inline callback with the given summary, every list empty unless overridden. */
function callback(overrides: Partial<Callback> = {}): Callback {
  return {
    functionLocal: [],
    viewUses: [],
    escapes: [],
    returns: [],
    varDecls: [],
    paramRedeclarations: [],
    directEval: [],
    hazards: [],
    params: 0,
    firstParam: "none",
    arrow: false,
    async: false,
    generator: false,
    exprBody: false,
    ...overrides,
  };
}

/** An arrow callback with one plain identifier parameter, which passes every callback check. */
function inlineArrow(overrides: Partial<Callback> = {}): Callback {
  return callback({ arrow: true, params: 1, firstParam: "identifier", ...overrides });
}

/** A callback that keeps its call a runtime call: it takes two parameters. */
function keptCallback(): Callback {
  return callback({ arrow: true, params: 2, firstParam: "identifier" });
}

/** A site for `op` whose call is the whole expression of a statement. */
function statement(op: Op, cb: Callback | undefined, ...reasons: Reason[]): Site {
  return {
    callback: cb,
    reasons,
    nested: [],
    shapes: [],
    declarationFiles: [],
    root: "",
    pos: at(0),
    call: 0,
    op,
    context: "expression-statement",
    filtered: false,
    arrayLiteral: false,
  };
}

/** `site` with its call ID, position, and nested sites set. */
function placed(site: Site, call: NodeID, offset: number, ...nested: Site[]): Site {
  return { ...site, call, pos: at(offset), nested };
}

const MOVER_SHAPE: ArchShape = {
  required: [
    {
      name: "Position",
      fields: [
        { name: "x", kind: "number" },
        { name: "y", kind: "number" },
      ],
      relation: false,
    },
  ],
  optional: [],
};

const STATUE_SHAPE: ArchShape = {
  required: [{ name: "Statue", fields: [], relation: false }],
  optional: [],
};

/** An each call over the mover shape with ID `call` at `offset`, holding `nested`. */
function eachAt(call: NodeID, offset: number, cb: Callback, ...nested: Site[]): Site {
  return { ...placed(statement("each", cb), call, offset, ...nested), shapes: [MOVER_SHAPE] };
}

/** The hoisted inlining of an each call over the mover shape with ID `call` at `offset`. */
function inlinedAt(call: NodeID, offset: number): EachInlining {
  return {
    call,
    pos: at(offset),
    shape: MOVER_SHAPE,
    mode: "hoisted",
    continues: [],
    varToLet: [],
  };
}

/** The bail of the call of `op` with ID `call` at `offset` for `reason`. */
function bailAt(call: NodeID, offset: number, reason: Reason, op: Op = "each"): Bail {
  return { call, op, reason, pos: at(offset) };
}

/** The VIEW_ESCAPES bail of the each call `call` at `offset`, whose message names `detail`. */
function viewEscapes(call: NodeID, offset: number, detail: string): Bail {
  return { ...bailAt(call, offset, "VIEW_ESCAPES"), detail };
}

/** The position at `line` and `column` of main.ts; its offset orders by line, then column. */
function lineColumn(line: number, column: number): Position {
  return { file: "main.ts", offset: line * 100 + column, line, column };
}

/** A view escape of `kind` at `line` and `column` of main.ts. */
function escapeAt(
  kind: Exclude<EscapeKind, "nested-loop">,
  line: number,
  column: number,
): ViewEscape {
  return { kind, node: 0, pos: lineColumn(line, column) };
}

/** A reference to the view at `line` and `column` from the callback of the nested loop `loop`. */
function fromLoop(loop: NodeID, line: number, column: number): ViewEscape {
  return { kind: "nested-loop", loop, node: 0, pos: lineColumn(line, column) };
}

/** An inline arrow callback whose view references escape at `escapes`. */
function escaping(...escapes: ViewEscape[]): Callback {
  return inlineArrow({ escapes });
}

/** `result` with its bails ordered by call ID. */
function bailsByCall(result: PlanResult): PlanResult {
  return { ...result, bails: result.bails.toSorted((a, b) => a.call - b.call) };
}

describe("plan", () => {
  describe("when sites nest", () => {
    it("bails in post-order by source offset", () => {
      const has = statement("has", undefined);
      const sites = [
        {
          ...eachAt(
            0,
            50,
            inlineArrow(),
            { ...eachAt(1, 70, inlineArrow(), placed(has, 2, 80)), filtered: true },
            placed(has, 3, 60),
          ),
          filtered: true,
        },
        placed(has, 4, 10),
      ];

      const result = plan(sites);

      expect(result).toStrictEqual({
        bails: [
          bailAt(4, 10, "OP_NOT_REWRITTEN", "has"),
          bailAt(3, 60, "OP_NOT_REWRITTEN", "has"),
          bailAt(2, 80, "OP_NOT_REWRITTEN", "has"),
          bailAt(1, 70, "OP_NOT_REWRITTEN"),
          bailAt(0, 50, "OP_NOT_REWRITTEN"),
        ],
        rewrites: [],
      });
    });
  });

  describe("when several each sites are eligible", () => {
    it("rewrites in post-order by source offset", () => {
      const sites = [
        eachAt(0, 10, inlineArrow(), eachAt(1, 20, inlineArrow())),
        eachAt(2, 5, inlineArrow()),
      ];

      const result = plan(sites);

      expect(result).toStrictEqual({
        bails: [bailAt(0, 10, "OP_NOT_REWRITTEN")],
        rewrites: [inlinedAt(2, 5), inlinedAt(1, 20)],
      });
    });

    it("rewrites siblings given out of order by source offset", () => {
      const result = plan([eachAt(1, 40, inlineArrow()), eachAt(0, 10, inlineArrow())]);

      expect(result).toStrictEqual({
        bails: [],
        rewrites: [inlinedAt(0, 10), inlinedAt(1, 40)],
      });
    });
  });

  describe("when several reasons apply", () => {
    it.each<{ name: string; site: Site; want: Reason }>([
      {
        name: "arg count before not statement",
        site: { ...statement("each", undefined, "ARG_COUNT"), context: "other-expression" },
        want: "ARG_COUNT",
      },
      {
        name: "not statement before callback not inline",
        site: { ...statement("each", undefined), context: "other-expression" },
        want: "NOT_STATEMENT",
      },
      {
        name: "callback not inline before storages dynamic",
        site: statement("each", undefined, "STORAGES_DYNAMIC"),
        want: "CALLBACK_NOT_INLINE",
      },
      {
        name: "async before generator",
        site: statement("each", callback({ async: true, generator: true })),
        want: "CALLBACK_ASYNC",
      },
      {
        name: "generator before params",
        site: statement("each", callback({ generator: true, params: 2 })),
        want: "CALLBACK_GENERATOR",
      },
      {
        name: "other first parameter before function bindings",
        site: statement("each", callback({ params: 1, firstParam: "other", functionLocal: [5] })),
        want: "CALLBACK_PARAMS",
      },
      {
        name: "two parameters before function bindings",
        site: statement(
          "each",
          callback({ params: 2, firstParam: "identifier", functionLocal: [5] }),
        ),
        want: "CALLBACK_PARAMS",
      },
      {
        name: "var redeclaring a destructured parameter before function bindings",
        site: statement(
          "each",
          callback({
            params: 1,
            firstParam: "object-pattern",
            paramRedeclarations: [4],
            functionLocal: [5],
          }),
        ),
        want: "CALLBACK_PARAMS",
      },
      {
        name: "function bindings before storages dynamic",
        site: statement(
          "each",
          callback({ params: 1, firstParam: "identifier", functionLocal: [5] }),
          "STORAGES_DYNAMIC",
        ),
        want: "CALLBACK_FUNCTION_BINDINGS",
      },
      {
        name: "query callback not inline",
        site: statement("query", undefined),
        want: "CALLBACK_NOT_INLINE",
      },
      {
        name: "first recorded reason wins",
        site: statement("each", inlineArrow(), "SHAPE_UNRESOLVED", "STORAGES_DYNAMIC"),
        want: "SHAPE_UNRESOLVED",
      },
      {
        name: "recorded reason before a view escape",
        site: statement("each", escaping(escapeAt("view", 3, 7)), "SHAPE_UNRESOLVED"),
        want: "SHAPE_UNRESOLVED",
      },
      {
        name: "recorded reason before an array literal of storages",
        site: { ...statement("each", inlineArrow(), "STORAGES_DYNAMIC"), arrayLiteral: true },
        want: "STORAGES_DYNAMIC",
      },
      {
        name: "other op skips the callback checks",
        site: statement("has", undefined),
        want: "OP_NOT_REWRITTEN",
      },
      {
        name: "other op surfaces a recorded reason",
        site: statement("has", undefined, "SHAPE_UNRESOLVED"),
        want: "SHAPE_UNRESOLVED",
      },
      {
        name: "other op with its value used",
        site: { ...statement("spawn", undefined), context: "other-expression" },
        want: "NOT_STATEMENT",
      },
    ])("picks the first that applies: $name", ({ site, want }) => {
      const result = plan([site]);

      expect(result.bails.map((bail) => bail.reason)).toStrictEqual([want]);
    });
  });

  describe("when an each site is eligible", () => {
    const returns: Return[] = [
      { node: 11, nested: false },
      { node: 12, nested: true },
    ];
    const vars: NodeID[] = [21, 22];

    it.each<{
      name: string;
      site: Site;
      mode: Mode;
      continues: readonly Return[];
      varToLet: readonly NodeID[];
    }>([
      {
        name: "expression statement with a hazard-free body carrying returns and var declarations",
        site: statement("each", inlineArrow({ returns, varDecls: vars })),
        mode: "hoisted",
        continues: returns,
        varToLet: vars,
      },
      {
        name: "arrow body",
        site: { ...statement("each", inlineArrow()), context: "arrow-body" },
        mode: "hoisted",
        continues: [],
        varToLet: [],
      },
      {
        name: "body with a hazard point",
        site: statement("each", inlineArrow({ hazards: [7] })),
        mode: "realloc-safe",
        continues: [],
        varToLet: [],
      },
      {
        name: "object-pattern parameter",
        site: statement("each", inlineArrow({ firstParam: "object-pattern" })),
        mode: "hoisted",
        continues: [],
        varToLet: [],
      },
      {
        name: "no parameter",
        site: statement("each", callback({ arrow: true })),
        mode: "hoisted",
        continues: [],
        varToLet: [],
      },
    ])("plans an inlining instead of a bail for $name", ({ site, mode, continues, varToLet }) => {
      const sites = [{ ...placed(site, 3, 40), shapes: [MOVER_SHAPE] }];

      const result = plan(sites);

      expect(result).toStrictEqual({
        bails: [],
        rewrites: [{ call: 3, pos: at(40), shape: MOVER_SHAPE, mode, continues, varToLet }],
      });
    });
  });

  describe("when a view reference escapes", () => {
    it.each<{ kind: Exclude<EscapeKind, "nested-loop" | "target">; use: string }>([
      { kind: "view", use: "the view as a value" },
      { kind: "computed", use: "a computed access" },
      { kind: "slot-value", use: "a slot as a value" },
      { kind: "key", use: "a key outside the shape" },
      { kind: "slot-assign", use: "an assignment to a slot" },
      { kind: "chain", use: "an optional chain past a field" },
      { kind: "nested", use: "a reference from a nested function" },
      { kind: "destructure", use: "a destructuring form that does not lower" },
      { kind: "field-call", use: "a field called as a method" },
      { kind: "boolean-arithmetic", use: "arithmetic on a boolean field" },
      { kind: "eval", use: "a direct eval" },
    ])("bails naming its line, column, and use for $use", ({ kind, use }) => {
      const sites = [eachAt(2, 20, escaping(escapeAt(kind, 3, 7)))];

      const result = plan(sites);

      expect(result).toStrictEqual({
        bails: [viewEscapes(2, 20, `line 3, column 7: ${use}`)],
        rewrites: [],
      });
    });

    it.each([
      {
        name: "the earliest escape is named whatever the recorded order",
        escapes: [escapeAt("view", 5, 2), escapeAt("key", 3, 9)],
        want: viewEscapes(2, 20, "line 3, column 9: a key outside the shape"),
      },
      {
        name: "a field target first reports an unsupported assignment",
        escapes: [escapeAt("target", 3, 4), escapeAt("view", 4, 2)],
        want: bailAt(2, 20, "UNSUPPORTED_ASSIGNMENT"),
      },
      {
        name: "an escape before a field target reports view escapes",
        escapes: [escapeAt("view", 3, 4), escapeAt("target", 4, 2)],
        want: viewEscapes(2, 20, "line 3, column 4: the view as a value"),
      },
    ])("reports the first in source order: $name", ({ escapes, want }) => {
      const sites = [eachAt(2, 20, escaping(...escapes))];

      const result = plan(sites);

      expect(result).toStrictEqual({ bails: [want], rewrites: [] });
    });
  });

  describe("when the call form has no rewrite", () => {
    const cb = escaping(escapeAt("view", 3, 7));
    const notRewritten = bailAt(2, 20, "OP_NOT_REWRITTEN");

    it.each([
      {
        name: "filtered each",
        site: { ...eachAt(2, 20, inlineArrow()), filtered: true },
        want: notRewritten,
      },
      {
        name: "filtered each with an escaping view reference",
        site: { ...eachAt(2, 20, cb), filtered: true },
        want: viewEscapes(2, 20, "line 3, column 7: the view as a value"),
      },
      {
        name: "each over an array literal of one storage with an escaping view reference",
        site: { ...eachAt(2, 20, cb), arrayLiteral: true },
        want: notRewritten,
      },
      {
        name: "each over an array literal of two storages",
        site: {
          ...eachAt(2, 20, inlineArrow()),
          arrayLiteral: true,
          shapes: [MOVER_SHAPE, STATUE_SHAPE],
        },
        want: notRewritten,
      },
      {
        name: "query with an escaping view reference",
        site: placed(statement("query", cb), 2, 20),
        want: bailAt(2, 20, "OP_NOT_REWRITTEN", "query"),
      },
    ])("bails silently unless a filtered each escapes: $name", ({ site, want }) => {
      const result = plan([site]);

      expect(result).toStrictEqual({ bails: [want], rewrites: [] });
    });
  });

  describe("when an each nests another each", () => {
    const keptLoopUse = "a reference from a nested callback that keeps its runtime call";
    const inlined = eachAt(2, 30, inlineArrow());
    const kept = eachAt(2, 30, keptCallback());
    const middle = eachAt(2, 30, keptCallback(), eachAt(3, 50, inlineArrow()));
    const silent = bailAt(1, 10, "OP_NOT_REWRITTEN");

    it.each<{ name: string; outer: Site; want: PlanResult }>([
      {
        name: "an each holding an inlined each keeps its runtime call silently",
        outer: eachAt(1, 10, escaping(), inlined),
        want: { bails: [silent], rewrites: [inlinedAt(2, 30)] },
      },
      {
        name: "a reference from the callback of an inlined each does not escape",
        outer: eachAt(1, 10, escaping(fromLoop(2, 3, 9)), inlined),
        want: { bails: [silent], rewrites: [inlinedAt(2, 30)] },
      },
      {
        name: "a reference from the callback of an each that keeps its runtime call escapes",
        outer: eachAt(1, 10, escaping(fromLoop(2, 3, 9)), kept),
        want: {
          bails: [
            bailAt(2, 30, "CALLBACK_PARAMS"),
            viewEscapes(1, 10, `line 3, column 9: ${keptLoopUse}`),
          ],
          rewrites: [],
        },
      },
      {
        name: "an each holding an each that keeps its runtime call is inlined when nothing escapes",
        outer: eachAt(1, 10, escaping(), kept),
        want: { bails: [bailAt(2, 30, "CALLBACK_PARAMS")], rewrites: [inlinedAt(1, 10)] },
      },
      {
        name: "an escape outside the inner callback is reported even when the inner each is inlined",
        outer: eachAt(1, 10, escaping(escapeAt("view", 6, 2)), inlined),
        want: {
          bails: [viewEscapes(1, 10, "line 6, column 2: the view as a value")],
          rewrites: [inlinedAt(2, 30)],
        },
      },
      {
        name: "a reference from the callback of an inlined each is passed over for the first escape",
        outer: eachAt(1, 10, escaping(fromLoop(2, 3, 9), escapeAt("view", 6, 2)), inlined),
        want: {
          bails: [viewEscapes(1, 10, "line 6, column 2: the view as a value")],
          rewrites: [inlinedAt(2, 30)],
        },
      },
      {
        name: "a reference from an inlined callback inside a kept callback escapes",
        outer: eachAt(1, 10, escaping(fromLoop(3, 4, 11)), middle),
        want: {
          bails: [
            bailAt(2, 30, "CALLBACK_PARAMS"),
            viewEscapes(1, 10, `line 4, column 11: ${keptLoopUse}`),
          ],
          rewrites: [inlinedAt(3, 50)],
        },
      },
      {
        name: "an each holding an inlined each at any depth keeps its runtime call silently",
        outer: eachAt(1, 10, escaping(), middle),
        want: {
          bails: [bailAt(2, 30, "CALLBACK_PARAMS"), silent],
          rewrites: [inlinedAt(3, 50)],
        },
      },
    ])("plans the inner first: $name", ({ outer, want }) => {
      const result = plan([outer]);

      expect(result).toStrictEqual(want);
    });
  });

  describe("when planning a site throws", () => {
    const shapelessDetail = "eligible each site has 0 shapes, want 1";
    const has = statement("has", undefined);
    const shapeless = statement("each", inlineArrow());

    it.each<{ name: string; sites: Site[]; want: PlanResult }>([
      {
        name: "enclosing site throws",
        sites: [placed(shapeless, 0, 0, placed(has, 1, 10)), placed(has, 2, 30)],
        want: {
          bails: [
            { ...bailAt(0, 0, "INTERNAL"), detail: shapelessDetail },
            bailAt(1, 10, "OP_NOT_REWRITTEN", "has"),
            bailAt(2, 30, "OP_NOT_REWRITTEN", "has"),
          ],
          rewrites: [],
        },
      },
      {
        name: "nested site throws",
        sites: [
          eachAt(0, 0, inlineArrow(), placed(shapeless, 1, 10), placed(has, 2, 20)),
          placed(has, 3, 30),
        ],
        want: {
          bails: [
            { ...bailAt(1, 10, "INTERNAL"), detail: shapelessDetail },
            bailAt(2, 20, "OP_NOT_REWRITTEN", "has"),
            bailAt(3, 30, "OP_NOT_REWRITTEN", "has"),
          ],
          rewrites: [inlinedAt(0, 0)],
        },
      },
    ])("bails only that site as internal: $name", ({ sites, want }) => {
      const result = plan(sites);

      expect(bailsByCall(result)).toStrictEqual(want);
    });

    it("bails only that site as internal when reading its nested sites throws", () => {
      const throwing: Site = {
        ...placed(has, 1, 10),
        get nested(): readonly Site[] {
          throw new Error("nested sites unreadable");
        },
      };

      const result = plan([throwing, placed(has, 2, 20)]);

      expect(result).toStrictEqual({
        bails: [
          { ...bailAt(1, 10, "INTERNAL", "has"), detail: "nested sites unreadable" },
          bailAt(2, 20, "OP_NOT_REWRITTEN", "has"),
        ],
        rewrites: [],
      });
    });

    it("carries a thrown value that is not an Error as text", () => {
      const throwing: Site = {
        ...placed(has, 1, 10),
        get reasons(): readonly Reason[] {
          // oxlint-disable-next-line typescript/only-throw-error -- the behavior under test is a thrown value that is not an Error
          throw 42;
        },
      };

      const result = plan([throwing, placed(has, 2, 20)]);

      expect(result).toStrictEqual({
        bails: [
          { ...bailAt(1, 10, "INTERNAL", "has"), detail: "42" },
          bailAt(2, 20, "OP_NOT_REWRITTEN", "has"),
        ],
        rewrites: [],
      });
    });
  });
});

describe("isReported", () => {
  it.each<{ name: string; reason: Reason; strict: boolean; want: boolean }>([
    { name: "silent under strict", reason: "NOT_STATEMENT", strict: true, want: false },
    { name: "silent without strict", reason: "OP_NOT_REWRITTEN", strict: false, want: false },
    { name: "strict under strict", reason: "SHAPE_UNRESOLVED", strict: true, want: true },
    { name: "strict without strict", reason: "SHAPE_UNRESOLVED", strict: false, want: false },
    { name: "warning under strict", reason: "CALLBACK_ASYNC", strict: true, want: true },
    { name: "warning without strict", reason: "CALLBACK_ASYNC", strict: false, want: true },
  ])("reports a $name bail: $want", ({ reason, strict, want }) => {
    const bail = bailAt(0, 0, reason);

    const reported = isReported(bail, strict);

    expect(reported).toBe(want);
  });
});
