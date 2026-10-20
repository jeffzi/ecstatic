import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { inlineCallback } from "../../../../src/plugin/optimizer/analysis/callback.js";
import type {
  Callback,
  NodeID,
  ParamForm,
  UseKind,
  ViewUse,
} from "../../../../src/plugin/optimizer/facts.js";
import type { NodeTable } from "../../../../src/plugin/optimizer/nodes.js";
import { SPAWN_TIMEOUT_MS } from "../project.js";
import {
  CallbackProject,
  DIRECT_EVAL_MARKS,
  EVAL_SOURCE,
  type Located,
  MARK_DECL,
  markOffset,
  nodeOffset,
  OWN_RETURNS,
  OWN_VAR_MARKS,
  REGISTER_DECL,
  RETURNS_SOURCE,
  VARS_SOURCE,
} from "./callback-project.js";

/** The syntactic form of an inline callback: every Callback field but the body summary. */
interface CallbackForm {
  readonly params: number;
  readonly firstParam: ParamForm;
  readonly arrow: boolean;
  readonly async: boolean;
  readonly generator: boolean;
  readonly exprBody: boolean;
}

/** The form of a callback with no parameter, written as a plain function expression. */
const BARE_FORM: CallbackForm = {
  params: 0,
  firstParam: "none",
  arrow: false,
  async: false,
  generator: false,
  exprBody: false,
};

/** An arrow taking one identifier parameter, with `overrides` applied. */
function arrowForm(overrides: Partial<CallbackForm> = {}): CallbackForm {
  return { ...BARE_FORM, params: 1, firstParam: "identifier", arrow: true, ...overrides };
}

/** A function expression taking one identifier parameter, with `overrides` applied. */
function functionForm(overrides: Partial<CallbackForm> = {}): CallbackForm {
  return { ...BARE_FORM, params: 1, firstParam: "identifier", ...overrides };
}

/** An arrow callback taking the view. */
const ARROW_SOURCE = "each(s, (e) => {});";

/** A function expression callback taking the view. */
const FUNCTION_SOURCE = "each(s, function (e) {});";

const FORM_CASES: readonly { name: string; source: string; want: CallbackForm }[] = [
  { name: "arrow with an identifier parameter", source: ARROW_SOURCE, want: arrowForm() },
  {
    name: "arrow with an expression body",
    source: "each(s, (e) => e);",
    want: arrowForm({ exprBody: true }),
  },
  { name: "async arrow", source: "each(s, async (e) => {});", want: arrowForm({ async: true }) },
  { name: "function expression", source: FUNCTION_SOURCE, want: functionForm() },
  {
    name: "generator function expression",
    source: "each(s, function* (e) {});",
    want: functionForm({ generator: true }),
  },
  {
    name: "async generator query callback without parameters",
    source: "query(s, [], async function* () {});",
    want: { ...BARE_FORM, async: true, generator: true },
  },
  {
    name: "object pattern parameter",
    source: "each(s, ({ id }: any) => {});",
    want: arrowForm({ firstParam: "object-pattern" }),
  },
  {
    name: "identifier parameter with a default",
    source: "each(s, (e = 0) => {});",
    want: arrowForm({ firstParam: "other" }),
  },
  {
    name: "object pattern parameter with a default",
    source: "each(s, ({ id }: any = {}) => {});",
    want: arrowForm({ firstParam: "other" }),
  },
  {
    name: "rest parameter",
    source: "each(s, (...e: number[]) => {});",
    want: arrowForm({ firstParam: "other" }),
  },
  {
    name: "array pattern parameter",
    source: "each(s, ([a]: any) => {});",
    want: arrowForm({ firstParam: "other" }),
  },
  {
    name: "second parameter counted",
    source: "each(s, (e, f = 0) => {});",
    want: arrowForm({ params: 2 }),
  },
  {
    name: "this parameter not counted",
    source: "each(s, function (this: unknown, e) {});",
    want: functionForm(),
  },
];

const NOT_INLINE_CASES: readonly { name: string; source: string }[] = [
  {
    name: "an identifier",
    source: "declare const move: (e: number) => void;\neach(s, move);",
  },
  {
    name: "a call result",
    source: "declare function makeMove(): (e: number) => void;\neach(s, makeMove());",
  },
  {
    name: "a member",
    source: "declare const handlers: { move: (e: number) => void };\neach(s, handlers.move);",
  },
  {
    name: "a call without arguments",
    source: "// @ts-expect-error -- a call without arguments still parses\neach();",
  },
];

/** An expected view use: its node starts at the first occurrence of `mark` in the case source. */
interface WantUse {
  readonly kind: UseKind;
  readonly mark: string;
  readonly comp?: string;
  readonly field?: string;
  readonly alias?: boolean;
}

/** A source whose callback references the view only in positions that lower, with its uses. */
interface UseCase {
  readonly name: string;
  readonly source: string;
  readonly want: readonly WantUse[];
}

const LOOSE_USE_CASES: readonly UseCase[] = [
  {
    name: "reads, assignments, updates, and id in source order",
    source: `${REGISTER_DECL}each(s, (e: any) => {
	e.Position.x = e.Velocity.dx;
	e.Position.y += 1;
	e.Flags.on ||= true;
	e.Health.hp++;
	--e.Health.hp;
	register(e.id);
});`,
    want: [
      { kind: "field-assign", comp: "Position", field: "x", mark: "e.Position.x =" },
      { kind: "field-read", comp: "Velocity", field: "dx", mark: "e.Velocity.dx" },
      { kind: "field-assign", comp: "Position", field: "y", mark: "e.Position.y +=" },
      { kind: "field-assign", comp: "Flags", field: "on", mark: "e.Flags.on ||=" },
      { kind: "field-update", comp: "Health", field: "hp", mark: "e.Health.hp++" },
      { kind: "field-update", comp: "Health", field: "hp", mark: "--e.Health.hp" },
      { kind: "id", mark: "e.id" },
    ],
  },
  {
    name: "an expression body",
    source: "each(s, (e: any) => e.Position.x);",
    want: [{ kind: "field-read", comp: "Position", field: "x", mark: "e.Position.x" }],
  },
  {
    name: "a function expression callback",
    source: "each(s, function (e: any) { e.Position.x = 1; });",
    want: [{ kind: "field-assign", comp: "Position", field: "x", mark: "e.Position.x" }],
  },
  {
    name: "a local shadowing the view, which is not the view",
    source: `each(s, (e: any) => {
	{
		const e = { Position: { x: 1 } };
		e.Position.x = 2;
	}
});`,
    want: [],
  },
];

const LOWERED_USE_CASES: readonly UseCase[] = [
  {
    name: "optional fields through a non-null assertion",
    source: `each(enemies, (e) => {
	e.Shield!.hp += e.Shield!.hp;
	e.Shield!.active = true;
});`,
    want: [
      { kind: "field-assign", comp: "Shield", field: "hp", mark: "e.Shield!.hp +=" },
      { kind: "field-read", comp: "Shield", field: "hp", mark: "e.Shield!.hp;" },
      { kind: "field-assign", comp: "Shield", field: "active", mark: "e.Shield!.active" },
    ],
  },
  {
    name: "an optional chain on a slot",
    source: `each(enemies, (e) => {
	xs.push(e.Shield?.hp ?? 0);
});`,
    want: [{ kind: "optional-read", comp: "Shield", field: "hp", mark: "e.Shield?.hp" }],
  },
  {
    name: "slots in test positions",
    source: `each(enemies, (e) => {
	if (e.Shield && e.Shield.hp > 0) xs.push(1);
	while (!e.Stunned) break;
	xs.push(e.Shield ? 1 : 0);
});`,
    want: [
      { kind: "presence", comp: "Shield", mark: "e.Shield &&" },
      { kind: "field-read", comp: "Shield", field: "hp", mark: "e.Shield.hp" },
      { kind: "presence", comp: "Stunned", mark: "e.Stunned)" },
      { kind: "presence", comp: "Shield", mark: "e.Shield ?" },
    ],
  },
  {
    name: "slots compared with undefined and null, either side",
    source: `each(enemies, (e) => {
	const a = e.Shield === undefined;
	const b = undefined !== e.Shield;
	const c = e.Shield == null || e.Position != null;
	const d = e.Shield === null;
	xs.push(+a, +b, +c, +d);
});`,
    want: [
      { kind: "compare", comp: "Shield", mark: "e.Shield === undefined" },
      { kind: "compare", comp: "Shield", mark: "undefined !== e.Shield" },
      { kind: "compare", comp: "Shield", mark: "e.Shield == null" },
      { kind: "compare", comp: "Position", mark: "e.Position != null" },
      { kind: "compare", comp: "Shield", mark: "e.Shield === null" },
    ],
  },
  {
    name: "a slot coalesced in a test",
    source: `each(enemies, (e) => {
	if (e.Shield ?? xs.length) xs.push(1);
});`,
    want: [{ kind: "coalesce", comp: "Shield", mark: "e.Shield ??" }],
  },
  {
    name: "slots reached by string keys",
    source: `each(enemies, (e) => {
	e["Position"].x += e["Shield"]!.hp;
	xs.push(e["Shield"]?.hp ?? 0);
	if (e["Shield"]) xs.push(1);
	const held = e["Shield"];
	if (held) held.hp = 1;
	const { "Velocity": v } = e;
	visit(v.dx);
});`,
    want: [
      { kind: "field-assign", comp: "Position", field: "x", mark: `e["Position"].x` },
      { kind: "field-read", comp: "Shield", field: "hp", mark: `e["Shield"]!.hp` },
      { kind: "optional-read", comp: "Shield", field: "hp", mark: `e["Shield"]?.hp` },
      { kind: "presence", comp: "Shield", mark: `e["Shield"])` },
      { kind: "alias", comp: "Shield", mark: `held = e["Shield"]` },
      { kind: "presence", comp: "Shield", mark: "held)", alias: true },
      { kind: "field-assign", comp: "Shield", field: "hp", mark: "held.hp", alias: true },
      { kind: "destructure", mark: `{ "Velocity": v } = e` },
      { kind: "alias", comp: "Velocity", mark: `"Velocity": v` },
      { kind: "field-read", comp: "Velocity", field: "dx", mark: "v.dx", alias: true },
    ],
  },
  {
    name: "an optional tag as a value",
    source: `each(enemies, (e) => {
	const stunned = e.Stunned;
	visit(stunned);
});`,
    want: [{ kind: "tag", comp: "Stunned", mark: "e.Stunned" }],
  },
  {
    name: "a required tag as a value",
    source: `each(marked, (e) => {
	visit(e.Stunned);
});`,
    want: [{ kind: "tag", comp: "Stunned", mark: "e.Stunned" }],
  },
  {
    name: "a relation data field",
    source: `each(linked, (e) => {
	e.ChildOf.order += 1;
});`,
    want: [{ kind: "field-assign", comp: "ChildOf", field: "order", mark: "e.ChildOf.order" }],
  },
  {
    name: "aliases of a slot, plain and non-null asserted",
    source: `each(enemies, (e) => {
	const shield = e.Shield;
	if (shield) shield.hp = 1;
	const held = e.Shield!;
	xs.push(held.hp, held === undefined ? 0 : 1, held?.hp ?? 0);
});`,
    want: [
      { kind: "alias", comp: "Shield", mark: "shield = e.Shield" },
      { kind: "presence", comp: "Shield", mark: "shield)", alias: true },
      { kind: "field-assign", comp: "Shield", field: "hp", mark: "shield.hp", alias: true },
      { kind: "alias", comp: "Shield", mark: "held = e.Shield!" },
      { kind: "field-read", comp: "Shield", field: "hp", mark: "held.hp", alias: true },
      { kind: "compare", comp: "Shield", mark: "held === undefined", alias: true },
      { kind: "optional-read", comp: "Shield", field: "hp", mark: "held?.hp", alias: true },
    ],
  },
  {
    name: "class evaluation code reading the view",
    source: `${MARK_DECL}each(enemies, (e) => {
	@mark(e.Position.x)
	class Probe {
		[String(e.Velocity.dx)](): void {}
		static hp = e.Position.y;
		static {
			xs.push(e.id);
		}
	}
	visit(Probe);
});`,
    want: [
      { kind: "field-read", comp: "Position", field: "x", mark: "e.Position.x)" },
      { kind: "field-read", comp: "Velocity", field: "dx", mark: "e.Velocity.dx" },
      { kind: "field-read", comp: "Position", field: "y", mark: "e.Position.y" },
      { kind: "id", mark: "e.id" },
    ],
  },
];

const LOWERED_PATTERN_CASES: readonly { name: string; source: string }[] = [
  {
    name: "a parameter pattern with nested defaults and optional slots",
    source: `each(enemies, ({ id, Position: p, Velocity: { dx, dy: vy = 0 }, Shield, Stunned }) => {
	p.x += dx + vy;
	if (Shield) Shield.hp = id;
	visit(Stunned);
	const later = () => dx;
	visit(later);
});`,
  },
  {
    name: "const and let patterns of the view and its slots",
    source: `each(enemies, (e) => {
	const { x, y: py = 1 } = e.Position;
	let { Velocity: v, id } = e;
	const { hp, label: { length } } = e.Shield!;
	const {} = e.Shield!;
	const { Position: { x: px } } = e;
	visit([x, py, v.dx, id, hp, length, px, () => x]);
});`,
  },
  {
    name: "a pattern of a relation field",
    source: `each(linked, (e) => {
	const { order, pinned } = e.ChildOf;
	visit(order + +pinned);
});`,
  },
];

/** Spawns into a storage whose shape differs from the iterated one. */
const SPAWN_ELSEWHERE_SOURCE = `const ships = register(createWorld(), Ship);
each(enemies, () => {
	spawn(ships);
});`;

/** A body whose recorded nodes `nodes` picks from the callback start at the marks. */
interface NodeListCase {
  readonly name: string;
  readonly source: string;
  readonly nodes: (callback: Callback) => readonly NodeID[];
  readonly marks: readonly string[];
}

const NODE_LIST_CASES: readonly NodeListCase[] = [
  {
    name: "the var declarations outside nested functions",
    source: VARS_SOURCE,
    nodes: (callback) => callback.varDecls,
    marks: OWN_VAR_MARKS,
  },
  {
    name: "the var declarations that redeclare a pattern binding",
    source: `each(s, ({ id, Position: p, Velocity: { dx: vx } }: any) => {
	var p;
	var other = 1, vx: any = 2;
	{
		var id: any = 0;
	}
	let shadow = 0;
	function inner() {
		var p;
	}
});`,
    nodes: (callback) => callback.paramRedeclarations,
    marks: ["p;", "vx: any = 2", "id: any = 0"],
  },
  {
    name: "every direct eval call",
    source: EVAL_SOURCE,
    nodes: (callback) => callback.directEval,
    marks: DIRECT_EVAL_MARKS,
  },
  {
    name: "the function-local reads of a function expression",
    source: `each(s, function visit(this: unknown, e) {
	this;
	arguments;
	new.target;
	visit;
});`,
    nodes: (callback) => callback.functionLocal,
    marks: ["this;", "arguments;", "new.target;", "visit;"],
  },
  {
    name: "no function-local reads for an arrow, whose this is the enclosing one",
    source: `each(s, (e) => {
	visit(this);
});
function visit(value: unknown): void {}`,
    nodes: (callback) => callback.functionLocal,
    marks: [],
  },
  {
    name: "the hazard points of the body, past view uses on an any-typed view",
    source: `${REGISTER_DECL}each(s, (e: any) => {
	e.Position.x = e.Velocity.dx;
	register(e.id);
});`,
    nodes: (callback) => callback.hazards,
    marks: ["register(e.id)"],
  },
  {
    name: "the hazard points of the parameter defaults",
    source: `declare function make(): number;
each(s, ({ Position: { x = make() } }: any) => {});`,
    nodes: (callback) => callback.hazards,
    marks: ["Position: {", "x = make", "make() }"],
  },
];

const project = new CallbackProject(
  [
    ...FORM_CASES.map(({ source }) => source),
    ...NOT_INLINE_CASES.map(({ source }) => source),
    ...LOOSE_USE_CASES.map(({ source }) => source),
    ...NODE_LIST_CASES.map(({ source }) => source),
    RETURNS_SOURCE,
  ],
  [
    ...LOWERED_USE_CASES.map(({ source }) => source),
    ...LOWERED_PATTERN_CASES.map(({ source }) => source),
    SPAWN_ELSEWHERE_SOURCE,
  ],
);

beforeAll(() => project.open(), SPAWN_TIMEOUT_MS);

afterAll(() => project.close());

/** A view use with the start offset of its node in place of its node ID. */
function useAt(
  table: NodeTable,
  { node, ...use }: ViewUse,
): Omit<ViewUse, "node"> & { offset: number } {
  return { ...use, offset: nodeOffset(table, node) };
}

/** The view use `want` describes, located in `located`. */
function wantedUse(
  located: Located,
  { mark, ...want }: WantUse,
): Omit<ViewUse, "node"> & { offset: number } {
  return {
    kind: want.kind,
    comp: want.comp ?? "",
    field: want.field ?? "",
    alias: want.alias ?? false,
    offset: markOffset(located, mark),
  };
}

describe("inlineCallback", () => {
  it.each(NOT_INLINE_CASES)("finds no inline callback in $name", async ({ source }) => {
    const { call } = await project.looseCall(source);

    const fn = inlineCallback(call, "each");

    expect(fn).toBeUndefined();
  });

  it("finds no inline callback for an op that does not iterate", async () => {
    const { call } = await project.looseCall(ARROW_SOURCE);

    const fn = inlineCallback(call, "spawn");

    expect(fn).toBeUndefined();
  });

  it.each([
    { name: "an arrow", source: ARROW_SOURCE },
    { name: "a function expression", source: FUNCTION_SOURCE },
  ])("finds $name written as the last argument", async ({ source }) => {
    const { call } = await project.looseCall(source);

    const fn = inlineCallback(call, "each");

    expect(fn).toBe(call.arguments.at(-1));
  });
});

describe("summarizeCallback", () => {
  it.each(FORM_CASES)("records the form of $name", async ({ source, want }) => {
    const located = await project.looseCall(source);

    const { callback } = await project.summarize(located);

    expect({
      params: callback.params,
      firstParam: callback.firstParam,
      arrow: callback.arrow,
      async: callback.async,
      generator: callback.generator,
      exprBody: callback.exprBody,
    }).toStrictEqual(want);
  });

  describe("when every view reference lowers", () => {
    it.each(LOOSE_USE_CASES)(
      "records each as a view use for $name, with no shape resolved",
      async ({ source, want }) => {
        const located = await project.looseCall(source);

        const { callback, table } = await project.summarize(located);

        expect(callback.viewUses.map((use) => useAt(table, use))).toStrictEqual(
          want.map((use) => wantedUse(located, use)),
        );
      },
    );

    it.each(LOWERED_USE_CASES)("records each as a view use for $name", async ({ source, want }) => {
      const located = await project.viewCall(source);

      const { callback, table } = await project.summarize(located);

      expect({
        uses: callback.viewUses.map((use) => useAt(table, use)),
        escapes: callback.escapes,
      }).toStrictEqual({ uses: want.map((use) => wantedUse(located, use)), escapes: [] });
    });

    it.each(LOWERED_PATTERN_CASES)("records no escape for $name", async ({ source }) => {
      const located = await project.viewCall(source);

      const { callback } = await project.summarize(located);

      expect(callback.escapes).toStrictEqual([]);
    });
  });

  it("records only its own returns, nested under a loop or switch or not", async () => {
    const located = await project.looseCall(RETURNS_SOURCE);

    const { callback, table } = await project.summarize(located);

    expect(
      callback.returns.map(({ node, nested }) => ({ offset: nodeOffset(table, node), nested })),
    ).toStrictEqual(
      OWN_RETURNS.map(({ mark, nth, nested }) => ({
        offset: markOffset(located, mark, nth),
        nested,
      })),
    );
  });

  it.each(NODE_LIST_CASES)("records $name", async ({ source, nodes, marks }) => {
    const located = await project.looseCall(source);

    const { callback, table } = await project.summarize(located);

    expect(nodes(callback).map((id) => nodeOffset(table, id))).toStrictEqual(
      marks.map((mark) => markOffset(located, mark)),
    );
  });

  it("adds the declaration files a spawn target's shape consulted to the site", async () => {
    const located = await project.viewCall(SPAWN_ELSEWHERE_SOURCE);

    const { site } = await project.summarize(located);

    expect(site.declarationFiles).toStrictEqual(
      expect.arrayContaining([join(project.root, "app", "archetypes.ts")]),
    );
  });
});
