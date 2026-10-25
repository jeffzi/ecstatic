import {
  type ArrowFunction,
  type FunctionExpression,
  getTouchingPropertyName,
} from "typescript/ast";
import { isArrowFunction, isCallExpression, isFunctionExpression } from "typescript/ast/is";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  directEvalCalls,
  functionLocalUses,
  ownReturns,
  ownVarDeclarations,
} from "../../../../src/plugin/optimizer/analysis/function-local.js";
import type { ProjectView, Session } from "../../../../src/plugin/optimizer/session.js";
import { locate } from "../locate.js";
import {
  appTsconfig,
  caseFiles,
  closeProject,
  openProject,
  projectPath,
  SPAWN_TIMEOUT_MS,
} from "../project.js";
import {
  DIRECT_EVAL_MARKS,
  EVAL_SOURCE,
  OWN_RETURNS,
  OWN_VAR_MARKS,
  RETURNS_SOURCE,
  VARS_SOURCE,
} from "./callback-project.js";

const HEADER = `declare function each(storage: unknown, callback: (this: unknown, entity: any) => void): void;
declare const s: unknown;
declare function register(value: unknown): void;
`;

/** The call whose last argument is the callback under test. */
const CALL = "each(s,";

interface Case {
  readonly name: string;
  readonly body: string;
  readonly marks: readonly string[];
}

const RECORDED_CASES: readonly Case[] = [
  {
    name: "this, arguments, and new.target in the body",
    body: `each(s, function (this: unknown, e) {
	this;
	arguments;
	new.target;
});`,
    marks: ["this;", "arguments;", "new.target;"],
  },
  {
    name: "every self-reference by name",
    body: `each(s, function visit(e) {
	visit;
	if (e > 0) visit(e - 1);
});`,
    marks: ["visit;", "visit(e - 1)"],
  },
  {
    name: "a self-reference written as a shorthand property",
    body: `each(s, function visit(e) {
	register({ visit });
});`,
    marks: ["visit }"],
  },
  {
    name: "arguments written as a shorthand property",
    body: `each(s, function (e) {
	register({ arguments });
});`,
    marks: ["arguments }"],
  },
  {
    name: "uses through a nested arrow",
    body: `each(s, function (this: unknown, e) {
	const read = () => [this, arguments, new.target, e];
	read();
});`,
    marks: ["this, arguments", "arguments, new", "new.target, e"],
  },
  {
    name: "this in a parameter default",
    body: "each(s, function (this: unknown, e: unknown = this) {});",
    marks: ["this) {"],
  },
  {
    name: "a value self-reference beside a type-position one",
    body: `each(s, function visit(e) {
	const g = visit as typeof visit;
});`,
    marks: ["visit as"],
  },
  {
    name: "a self-reference in a nested function expression body and parameter default",
    body: `each(s, function visit(e) {
	(function (n: unknown = visit.length) { return visit.name; })();
});`,
    marks: ["visit.length", "visit.name"],
  },
  {
    name: "a self-reference in a nested function declaration body and parameter default",
    body: `each(s, function visit(e) {
	function inner(n: unknown = visit.length) { return visit.name; }
	inner();
});`,
    marks: ["visit.length", "visit.name"],
  },
  {
    name: "a self-reference in class members and instance field initializers",
    body: `each(s, function visit(e) {
	class Local {
		field: unknown = visit.length;
		constructor(n: unknown = visit.name) { visit.call; }
		method(m: unknown = visit.apply): unknown { return visit.bind; }
		get value(): unknown { return visit.toString; }
		set value(v: unknown) { visit.prototype; }
	}
});`,
    marks: [
      "visit.length",
      "visit.name",
      "visit.call",
      "visit.apply",
      "visit.bind",
      "visit.toString",
      "visit.prototype",
    ],
  },
  {
    name: "a self-reference in object literal methods and accessors",
    body: `each(s, function visit(e) {
	const o = {
		method(m: unknown = visit.length): unknown { return visit.name; },
		get value(): unknown { return visit.call; },
		set value(v: unknown) { visit.apply; },
	};
});`,
    marks: ["visit.length", "visit.name", "visit.call", "visit.apply"],
  },
  {
    name: "a self-reference in an arrow inside a nested function, class member, or object method",
    body: `each(s, function visit(e) {
	(function () { return () => visit.length; })();
	class Local {
		method(): unknown { return () => visit.name; }
	}
	const o = { method(): unknown { return () => visit.call; } };
});`,
    marks: ["visit.length", "visit.name", "visit.call"],
  },
];

const UNRECORDED_CASES: readonly Case[] = [
  {
    name: "an arrow callback",
    body: `function outer(this: unknown) {
	each(s, (e) => [this, arguments, new.target, e]);
}`,
    marks: [],
  },
  {
    name: "this, arguments, and new.target in nested non-arrow functions",
    body: `each(s, function (e) {
	(function (this: unknown, n: unknown = [this, arguments, new.target]) { return [this, arguments, new.target]; })();
	function inner(this: unknown) { return [this, arguments, new.target]; }
});`,
    marks: [],
  },
  {
    name: "this, arguments, and new.target in class members and instance field initializers",
    body: `each(s, function (e) {
	class Local {
		field: unknown = [this];
		constructor() { [this, arguments, new.target]; }
		method(): unknown { return [this, arguments]; }
		get value(): unknown { return [this]; }
		set value(v: unknown) { [this, arguments, v]; }
	}
});`,
    marks: [],
  },
  {
    name: "this and arguments in object literal methods and accessors",
    body: `each(s, function (e) {
	const o = {
		method(): unknown { return [this, arguments]; },
		get value(): unknown { return [this]; },
		set value(v: unknown) { [this, arguments, v]; },
	};
});`,
    marks: [],
  },
  {
    name: "a local and a parameter shadowing the function name",
    body: `each(s, function visit(e) {
	{
		const visit = e;
		visit;
	}
	[0].forEach((visit) => visit);
});`,
    marks: [],
  },
  {
    name: "a parameter of a nested function shadowing the function name",
    body: `each(s, function visit(e) {
	(function (visit: unknown, n: unknown = visit) { return [visit, n]; })(e);
});`,
    marks: [],
  },
  {
    name: "a local of a nested function shadowing the function name",
    body: `each(s, function visit(e) {
	(function () { const visit = e; return visit; })();
});`,
    marks: [],
  },
  {
    name: "a function declaration in a nested function shadowing the function name",
    body: `each(s, function visit(e) {
	(function () { visit(); function visit(): void {} })();
});`,
    marks: [],
  },
  {
    name: "a named function expression in a nested function shadowing the function name",
    body: `each(s, function visit(e) {
	(function () { return function visit(): unknown { return visit; }; })();
});`,
    marks: [],
  },
  {
    name: "a class declaration in a nested function shadowing the function name",
    body: `each(s, function visit(e) {
	(function () { class visit {} return visit; })();
});`,
    marks: [],
  },
  {
    name: "a shorthand property of another variable",
    body: `each(s, function visit(e) {
	const other = e;
	register({ other });
});`,
    marks: [],
  },
  {
    name: "a shorthand property of a local shadowing the function name",
    body: `each(s, function visit(e) {
	{
		const visit = e;
		register({ visit });
	}
});`,
    marks: [],
  },
  {
    name: "a shorthand arguments property in a nested non-arrow function",
    body: `each(s, function (e) {
	(function () { register({ arguments }); })();
});`,
    marks: [],
  },
];

const CLASS_EVALUATION_CASES: readonly Case[] = [
  {
    name: "class and member decorators",
    body: `declare function tag(value: unknown): (target: unknown, context: unknown) => void;
each(s, function (this: unknown, e) {
	@tag(this)
	class Local {
		@tag(arguments) method(): void {}
		@tag(new.target) other(): void {}
	}
});`,
    marks: ["this)", "arguments)", "new.target)"],
  },
  {
    name: "parameter decorators but not parameter initializers",
    body: `declare function tag(value: unknown): (target: unknown, key: unknown, index: number) => void;
each(s, function (this: unknown, e) {
	class Local {
		// @ts-expect-error -- a parameter decorator needs experimentalDecorators; it still evaluates in the callback
		constructor(@tag(this) first: unknown) {}
		// @ts-expect-error -- as above
		method(@tag(arguments) second: unknown, third = arguments): void {}
		// @ts-expect-error -- as above
		set value(@tag(new.target) fourth: unknown) {}
	}
});`,
    marks: ["this)", "arguments)", "new.target)"],
  },
  {
    name: "computed member names",
    body: `declare function key<K extends string>(value: unknown, name: K): K;
each(s, function visit(this: unknown, e) {
	class Local {
		[visit.name](): void {}
		[String(arguments.length)](): void {}
		[String(new.target)](): void {}
		// @ts-expect-error -- this in a class computed name is rejected; it still evaluates in the callback
		[key(this, "method")](): void {}
		// @ts-expect-error -- as above
		[key(this, "field")]: unknown;
	}
});`,
    marks: ["visit.name", "arguments.length", "new.target)", `this, "method"`, `this, "field"`],
  },
  {
    name: "static blocks, which bind their own this and new.target",
    body: `each(s, function visit(e) {
	class Local {
		static {
			this;
			// @ts-expect-error -- new.target in a static block is rejected; it still evaluates there
			new.target;
			visit;
			const read = () => this;
			// @ts-expect-error -- as above
			const target = () => new.target;
		}
	}
});`,
    marks: ["visit;"],
  },
  {
    name: "static field initializers, which bind their own this and new.target",
    body: `each(s, function visit(e) {
	class Local {
		static own = this;
		// @ts-expect-error -- new.target in a static field initializer is rejected; it still evaluates there
		static target = new.target;
		static self = visit;
		static read = () => this;
		// @ts-expect-error -- as above
		static readTarget = () => new.target;
	}
});`,
    marks: ["visit;"],
  },
];

const EXPRESSION_BODY = "each(s, (e: any) => e);";

const BODIES = [
  ...[...RECORDED_CASES, ...UNRECORDED_CASES, ...CLASS_EVALUATION_CASES].map(({ body }) => body),
  RETURNS_SOURCE,
  VARS_SOURCE,
  EVAL_SOURCE,
  EXPRESSION_BODY,
];

const CASE_STEM = "app/case";

let root = "";
let session: Session;
let view: ProjectView;

beforeAll(async () => {
  ({ root, session, view } = await openProject({
    "tsconfig.json": appTsconfig({ lib: ["es2024"] }),
    ...caseFiles(CASE_STEM, BODIES, HEADER),
  }));
}, SPAWN_TIMEOUT_MS);

afterAll(() => closeProject(session));

interface Located {
  readonly callback: ArrowFunction | FunctionExpression;
  /** The offset in the case file of the first occurrence of each mark. */
  readonly offsets: (marks: readonly string[]) => number[];
  /** The offset in the case file of the `nth` occurrence of `mark`. */
  readonly offset: (mark: string, nth?: number) => number;
}

/** The inline callback the first `each` call of the case file holding `body` passes. */
async function callbackIn(body: string): Promise<Located> {
  const fileName = projectPath(root, `${CASE_STEM}${BODIES.indexOf(body)}.ts`);
  const source = await view.sourceFile(fileName);
  const call = getTouchingPropertyName(source, source.text.indexOf(CALL)).parent;
  const callback = isCallExpression(call) ? call.arguments.at(-1) : undefined;
  if (callback === undefined || !(isArrowFunction(callback) || isFunctionExpression(callback))) {
    throw new Error(`${body} passes no inline callback`);
  }
  const offset = (mark: string, nth = 0): number => locate(fileName, source.text, mark, nth).offset;
  return { callback, offset, offsets: (marks) => marks.map((mark) => offset(mark)) };
}

describe("ownReturns", () => {
  it("lists only the callback's own returns, nested under a loop or switch or not", async () => {
    const { callback, offset } = await callbackIn(RETURNS_SOURCE);

    const returns = ownReturns(callback).map(({ node, nested }) => ({
      offset: node.getStart(),
      nested,
    }));

    expect(returns).toStrictEqual(
      OWN_RETURNS.map(({ mark, nth, nested }) => ({ offset: offset(mark, nth), nested })),
    );
  });

  it("lists none for an expression body", async () => {
    const { callback } = await callbackIn(EXPRESSION_BODY);

    const returns = ownReturns(callback);

    expect(returns).toStrictEqual([]);
  });
});

describe("ownVarDeclarations", () => {
  it("lists the var declarations outside nested functions and static blocks", async () => {
    const { callback, offsets } = await callbackIn(VARS_SOURCE);

    const declarations = ownVarDeclarations(callback).map((node) => node.getStart());

    expect(declarations).toStrictEqual(offsets(OWN_VAR_MARKS));
  });
});

describe("directEvalCalls", () => {
  it("lists every direct eval call, through wrappers and nested functions", async () => {
    const { callback, offsets } = await callbackIn(EVAL_SOURCE);

    const calls = directEvalCalls(callback).map((node) => node.getStart());

    expect(calls).toStrictEqual(offsets(DIRECT_EVAL_MARKS));
  });
});

describe("functionLocalUses", () => {
  it.each([...RECORDED_CASES, ...CLASS_EVALUATION_CASES])(
    "records $name",
    async ({ body, marks }) => {
      const { callback, offsets } = await callbackIn(body);

      const uses = await functionLocalUses(view.checker, callback);

      expect(uses.map((node) => node.getStart())).toStrictEqual(offsets(marks));
    },
  );

  it.each(UNRECORDED_CASES)("records nothing for $name", async ({ body }) => {
    const { callback } = await callbackIn(body);

    const uses = await functionLocalUses(view.checker, callback);

    expect(uses).toStrictEqual([]);
  });
});
