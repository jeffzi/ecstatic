import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { EscapeKind } from "../../../../src/plugin/optimizer/facts.js";
import { SPAWN_TIMEOUT_MS } from "../project.js";
import {
  CallbackProject,
  caseOccurrence,
  MARK_DECL,
  markOffset,
  nodeOffset,
} from "./callback-project.js";

/** An expected view escape: its node starts at the `nth` (from 0) occurrence of `mark`. */
interface WantEscape {
  readonly mark: string;
  readonly kind: EscapeKind;
  readonly nth?: number;
}

/** A source whose callback references the view in positions that do not lower. */
interface EscapeCase {
  readonly name: string;
  readonly source: string;
  readonly want: readonly WantEscape[];
}

const VALUE_ESCAPE_CASES: readonly EscapeCase[] = [
  {
    name: "the view passed, stored, compared, and returned",
    source: `each(enemies, (e) => {
	visit(e);
	const held = e;
	if (e === held) xs.push(1);
	return e;
});`,
    want: [
      { mark: "e);", kind: "view" },
      { mark: "e;", kind: "view" },
      { mark: "e === held", kind: "view" },
      { mark: "e;", nth: 1, kind: "view" },
    ],
  },
  {
    name: "computed access on the view or a slot",
    source: `each(enemies, (e) => {
	visit([e[String("Position") as "Position"].x, e["id"], e["toString"], e?.["Position"].x, e.Position["x"]]);
});`,
    want: [
      { mark: "e[String", kind: "computed" },
      { mark: `e["id"]`, kind: "computed" },
      { mark: `e["toString"]`, kind: "computed" },
      { mark: `e?.["Position"]`, kind: "computed" },
      { mark: `e.Position["x"]`, kind: "computed" },
    ],
  },
  {
    name: "data slots used as values",
    source: `each(enemies, (e) => {
	const hp = e.Shield && e.Shield.hp;
	const either = e.Shield ?? xs;
	let slot = e.Position;
	visit([hp, either, slot]);
});`,
    want: [
      { mark: "e.Shield &&", kind: "slot-value" },
      { mark: "e.Shield ??", kind: "slot-value" },
      { mark: "e.Position;", kind: "slot-value" },
    ],
  },
  {
    name: "an alias referenced as a value",
    source: `each(enemies, (e) => {
	const shield = e.Shield;
	visit(shield);
});`,
    want: [{ mark: "shield);", kind: "slot-value" }],
  },
  {
    name: "keys outside the shape",
    source: `each(linked, (e: any) => {
	visit(e.toString());
	visit(e.Position.constructor);
	visit(e.ChildOf.target);
	visit(e.Velocity.dx);
});`,
    want: [
      { mark: "e.toString", kind: "key" },
      { mark: "e.Position.constructor", kind: "key" },
      { mark: "e.ChildOf.target", kind: "key" },
      { mark: "e.Velocity", kind: "key" },
    ],
  },
];

const FORM_ESCAPE_CASES: readonly EscapeCase[] = [
  {
    name: "slots and the id assigned",
    source: `each(enemies, (e: any) => {
	e.Position = { x: 1, y: 2 };
	e.id = 0;
	e.Shield++;
});`,
    want: [
      { mark: "e.Position =", kind: "slot-assign" },
      { mark: "e.id =", kind: "slot-assign" },
      { mark: "e.Shield++", kind: "slot-assign" },
    ],
  },
  {
    name: "an optional chain continued past the field",
    source: `each(enemies, (e) => {
	visit(e.Shield?.label.length);
});`,
    want: [{ mark: "e.Shield?.label", kind: "chain" }],
  },
  {
    name: "references inside nested functions",
    source: `each(enemies, (e) => {
	const later = () => e.id;
	const shield = e.Shield;
	function read(): number {
		return shield ? shield.hp : 0;
	}
	visit([later, read]);
});`,
    want: [
      { mark: "e.id;", kind: "nested" },
      { mark: "shield ?", kind: "nested" },
      { mark: "shield.hp", kind: "nested" },
    ],
  },
  {
    name: "a reference inside the callback of a nested each",
    source: `each(enemies, (e) => {
	each(linked, () => {
		visit(e.Position.x);
	});
});`,
    want: [{ mark: "e.Position.x", kind: "nested-loop" }],
  },
  {
    name: "fields as destructuring-assignment and for-of targets",
    source: `each(enemies, (e) => {
	[e.Position.x] = [1];
	({ y: e.Position.y } = { y: 1 });
	for (e.Velocity.dx of xs) visit(0);
});`,
    want: [
      { mark: "e.Position.x]", kind: "target" },
      { mark: "e.Position.y }", kind: "target" },
      { mark: "e.Velocity.dx of", kind: "target" },
    ],
  },
];

const OPERATION_ESCAPE_CASES: readonly EscapeCase[] = [
  {
    name: "a plain field called as a method",
    source: `import { ref } from "../../src/ecstatic/index.js";

const Hook = component("Hook", { run: ref<() => number>() });
const hooked = register(createWorld(), archetype([Hook]));
each(hooked, (e) => {
	visit(e.Hook.run!());
	visit(e.Hook.run?.());
});`,
    want: [
      { mark: "e.Hook.run!()", kind: "field-call" },
      { mark: "e.Hook.run?.()", kind: "field-call" },
    ],
  },
  {
    name: "a number field called through a loosely typed view",
    source: `each(enemies, (e: any) => {
	visit(e.Position.x());
});`,
    want: [{ mark: "e.Position.x()", kind: "field-call" }],
  },
  {
    name: "updates and arithmetic compound operators on a boolean field",
    source: `each(enemies, (e: any) => {
	e.Shield.active++;
	e.Shield.active += 1;
	e.Shield.active *= 2;
	e.Shield.active ||= false;
});`,
    want: [
      { mark: "e.Shield.active++", kind: "boolean-arithmetic" },
      { mark: "e.Shield.active +=", kind: "boolean-arithmetic" },
      { mark: "e.Shield.active *=", kind: "boolean-arithmetic" },
    ],
  },
];

const PATTERN_ESCAPE_CASES: readonly EscapeCase[] = [
  {
    name: "slots bound by a parameter pattern, used as a value and from a nested function",
    source: `each(enemies, ({ Position, Velocity: v }) => {
	visit(Position);
	const later = () => v.dx;
	visit(later);
});`,
    want: [
      { mark: "Position);", kind: "slot-value" },
      { mark: "v.dx", kind: "nested" },
    ],
  },
  {
    name: "a rest element in a parameter pattern",
    source: `each(enemies, ({ id, ...others }) => {
	visit([id, others]);
});`,
    want: [{ mark: "...others", kind: "destructure" }],
  },
  {
    name: "rest elements in patterns of the view and of a slot",
    source: `each(enemies, (e) => {
	const { id, ...others } = e;
	const { Position: { ...xy } } = e;
	visit([id, others, xy]);
});`,
    want: [
      { mark: "...others", kind: "destructure" },
      { mark: "...xy", kind: "destructure" },
    ],
  },
  {
    name: "computed keys in patterns of the view and of a slot",
    source: `each(enemies, (e) => {
	const key = "x" as const;
	const { ["Position"]: p } = e;
	const { [key]: x } = e.Position;
	visit([p, x]);
});`,
    want: [
      { mark: `["Position"]`, kind: "computed" },
      { mark: "[key]", kind: "computed" },
    ],
  },
  {
    name: "defaults on slots",
    source: `each(enemies, (e) => {
	const { Shield: s = undefined } = e;
	const { Velocity: { dx } = { dx: 0 } } = e;
	visit([s, dx]);
});`,
    want: [
      { mark: "Shield: s", kind: "destructure" },
      { mark: "Velocity: {", kind: "destructure" },
    ],
  },
  {
    name: "pattern keys outside the shape",
    source: `each(linked, (e: any) => {
	const { toString } = e;
	const { constructor: make } = e.Position;
	const { ChildOf: { target }, Velocity } = e;
	visit([toString, make, target, Velocity]);
});`,
    want: [
      { mark: "toString }", kind: "key" },
      { mark: "constructor: make", kind: "key" },
      { mark: "target }", kind: "key" },
      { mark: "Velocity }", kind: "key" },
    ],
  },
  {
    name: "a var declaration destructuring a slot",
    source: `each(enemies, (e) => {
	var { x } = e.Position;
	visit(x);
});`,
    want: [{ mark: "e.Position;", kind: "destructure" }],
  },
];

const EVALUATION_ESCAPE_CASES: readonly EscapeCase[] = [
  {
    name: "class evaluation code and class members",
    source: `${MARK_DECL}each(enemies, (e) => {
	@mark(e)
	class Probe {
		[String(e)](): void {}
		static held = e;
		static {
			visit(e);
		}
		own = e.id;
		read(): number {
			return e.id;
		}
	}
	visit(Probe);
});`,
    want: [
      { mark: "e)\n\tclass", kind: "view" },
      { mark: "e)]", kind: "view" },
      { mark: "e;", kind: "view" },
      { mark: "e);", kind: "view" },
      { mark: "e.id;", kind: "nested" },
      { mark: "e.id;", nth: 1, kind: "nested" },
    ],
  },
  {
    name: "direct eval in the body and in a nested function",
    source: `each(enemies, (e) => {
	e.Position.x = 1;
	eval("visit(e)");
	visit(() => eval("1"));
});`,
    want: [
      { mark: `eval("visit(e)")`, kind: "eval" },
      { mark: `eval("1")`, kind: "eval" },
    ],
  },
];

const ESCAPE_CASES: readonly EscapeCase[] = [
  ...VALUE_ESCAPE_CASES,
  ...FORM_ESCAPE_CASES,
  ...OPERATION_ESCAPE_CASES,
  ...PATTERN_ESCAPE_CASES,
  ...EVALUATION_ESCAPE_CASES,
];

/** Lets the view escape once directly in the callback and once from a nested function. */
const POSITIONED_ESCAPES_SOURCE = `each(enemies, (e) => {
	visit(e);
	visit(() => e.id);
});`;

/** References the views of two enclosing each calls from the callbacks of the loops nested in them. */
const NESTED_LOOPS_SOURCE = `each(enemies, (e) => {
	each(linked, (l) => {
		visit(e.Position.x);
		each(marked, () => {
			visit(e.id + l.id);
		});
	});
});`;

const project = new CallbackProject(
  [],
  [...ESCAPE_CASES.map(({ source }) => source), POSITIONED_ESCAPES_SOURCE, NESTED_LOOPS_SOURCE],
);

beforeAll(() => project.open(), SPAWN_TIMEOUT_MS);

afterAll(() => project.close());

describe("summarizeCallback", () => {
  describe("when a view reference does not lower", () => {
    it.each(ESCAPE_CASES)(
      "records the node, position, and kind of each for $name",
      async ({ source, want }) => {
        const located = await project.viewCall(source);

        const { callback, table } = await project.summarize(located);

        expect(
          callback.escapes.map(({ node, pos, kind }) => ({
            offset: nodeOffset(table, node),
            pos,
            kind,
          })),
        ).toStrictEqual(
          want.map(({ mark, nth, kind }) => ({
            offset: markOffset(located, mark, nth),
            pos: caseOccurrence(located, mark, nth),
            kind,
          })),
        );
      },
    );

    it("records the position of its node", async () => {
      const located = await project.viewCall(POSITIONED_ESCAPES_SOURCE);

      const { callback } = await project.summarize(located);

      expect(callback.escapes.map(({ pos }) => pos)).toStrictEqual(
        ["e);", "e.id"].map((mark) => caseOccurrence(located, mark)),
      );
    });
  });

  describe("when a nested loop callback references an outer view", () => {
    it.each([
      { name: "the outer callback", loop: "each(enemies", want: ["each(linked", "each(marked"] },
      { name: "the middle callback", loop: "each(linked", want: ["each(marked"] },
    ])("records the innermost loop from $name", async ({ loop, want }) => {
      const located = await project.viewCall(NESTED_LOOPS_SOURCE);

      const { callback, table } = await project.summarize(located, loop);

      expect(
        callback.escapes.map((escape) => ({
          kind: escape.kind,
          loop: escape.kind === "nested-loop" ? nodeOffset(table, escape.loop) : undefined,
        })),
      ).toStrictEqual(
        want.map((mark) => ({ kind: "nested-loop", loop: markOffset(located, mark) })),
      );
    });
  });
});
