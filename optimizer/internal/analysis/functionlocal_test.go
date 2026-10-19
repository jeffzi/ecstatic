package analysis_test

import (
	"slices"
	"testing"

	"github.com/jeffzi/ecstatic/optimizer/internal/facts"
)

// functionLocalCase lists in marks the source texts whose first occurrence starts each expected function-local use.
type functionLocalCase struct {
	name  string
	body  string
	marks []string
}

// checkFunctionLocal runs each case and compares the start offsets of its callback's function-local uses with its marks.
func checkFunctionLocal(t *testing.T, tests []functionLocalCase) {
	t.Helper()
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			checkCallbackOffsets(t, tt.body, tt.marks, func(cb *facts.Callback) []facts.NodeID { return cb.FunctionLocal })
		})
	}
}

// recordedFunctionLocalCases holds callbacks whose function-local uses belong to the callback.
func recordedFunctionLocalCases() []functionLocalCase {
	return []functionLocalCase{
		{
			name: "this, arguments, and new.target in the body",
			body: `each(s, function (this: unknown, e) {
	this;
	arguments;
	new.target;
});`,
			marks: []string{"this;", "arguments;", "new.target;"},
		},
		{
			name: "every self-reference by name",
			body: `each(s, function visit(e) {
	visit;
	if (e > 0) visit(e - 1);
});`,
			marks: []string{"visit;", "visit(e - 1)"},
		},
		{
			name: "self-reference written as a shorthand property",
			body: registerDecl + `each(s, function visit(e) {
	register({ visit });
});`,
			marks: []string{"visit }"},
		},
		{
			name: "arguments written as a shorthand property",
			body: registerDecl + `each(s, function (e) {
	register({ arguments });
});`,
			marks: []string{"arguments }"},
		},
		{
			name: "through a nested arrow",
			body: `each(s, function (this: unknown, e) {
	const read = () => [this, arguments, new.target, e];
	read();
});`,
			marks: []string{"this, arguments", "arguments, new", "new.target, e"},
		},
		{
			name:  "in a parameter default",
			body:  "each(s, function (this: unknown, e: unknown = this) {});",
			marks: []string{"this) {"},
		},
		{
			name: "value self-reference beside a type-position one",
			body: `each(s, function visit(e) {
	const g = visit as typeof visit;
});`,
			marks: []string{"visit as"},
		},
	}
}

// recordedNestedSelfReferenceCases holds callbacks whose own name is referenced inside a nested function, class member, or object method.
func recordedNestedSelfReferenceCases() []functionLocalCase {
	return []functionLocalCase{
		{
			name: "self-reference in a nested function expression body and parameter default",
			body: `each(s, function visit(e) {
	(function (n: unknown = visit.length) { return visit.name; })();
});`,
			marks: []string{"visit.length", "visit.name"},
		},
		{
			name: "self-reference in a nested function declaration body and parameter default",
			body: `each(s, function visit(e) {
	function inner(n: unknown = visit.length) { return visit.name; }
	inner();
});`,
			marks: []string{"visit.length", "visit.name"},
		},
		{
			name: "self-reference in class members and instance field initializers",
			body: `each(s, function visit(e) {
	class Local {
		field: unknown = visit.length;
		constructor(n: unknown = visit.name) { visit.call; }
		method(m: unknown = visit.apply): unknown { return visit.bind; }
		get value(): unknown { return visit.toString; }
		set value(v: unknown) { visit.prototype; }
	}
});`,
			marks: []string{"visit.length", "visit.name", "visit.call", "visit.apply", "visit.bind", "visit.toString", "visit.prototype"},
		},
		{
			name: "self-reference in object literal methods and accessors",
			body: `each(s, function visit(e) {
	const o = {
		method(m: unknown = visit.length): unknown { return visit.name; },
		get value(): unknown { return visit.call; },
		set value(v: unknown) { visit.apply; },
	};
});`,
			marks: []string{"visit.length", "visit.name", "visit.call", "visit.apply"},
		},
		{
			name: "self-reference in an arrow nested inside a nested function, class member, or object method",
			body: `each(s, function visit(e) {
	(function () { return () => visit.length; })();
	class Local {
		method(): unknown { return () => visit.name; }
	}
	const o = { method(): unknown { return () => visit.call; } };
});`,
			marks: []string{"visit.length", "visit.name", "visit.call"},
		},
	}
}

// unrecordedFunctionLocalCases holds callbacks whose matching names and keywords belong to another scope.
func unrecordedFunctionLocalCases() []functionLocalCase {
	return []functionLocalCase{
		{
			name: "arrow callback",
			body: `function outer(this: unknown) {
	each(s, (e) => [this, arguments, new.target, e]);
}`,
		},
		{
			name: "this, arguments, and new.target in nested non-arrow functions",
			body: `each(s, function (e) {
	(function (this: unknown, n: unknown = [this, arguments, new.target]) { return [this, arguments, new.target]; })();
	function inner(this: unknown) { return [this, arguments, new.target]; }
});`,
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
		},
		{
			name: "local and parameter shadowing the function name",
			body: `each(s, function visit(e) {
	{
		const visit = e;
		visit;
	}
	[0].forEach((visit) => visit);
});`,
		},
	}
}

// unrecordedShadowingCases holds callbacks whose function name is shadowed inside a nested function.
func unrecordedShadowingCases() []functionLocalCase {
	return []functionLocalCase{
		{
			name: "parameter of a nested function shadowing the function name",
			body: `each(s, function visit(e) {
	(function (visit: unknown, n: unknown = visit) { return [visit, n]; })(e);
});`,
		},
		{
			name: "local of a nested function shadowing the function name",
			body: `each(s, function visit(e) {
	(function () { const visit = e; return visit; })();
});`,
		},
		{
			name: "function declaration in a nested function shadowing the function name",
			body: `each(s, function visit(e) {
	(function () { visit(); function visit(): void {} })();
});`,
		},
		{
			name: "named function expression in a nested function shadowing the function name",
			body: `each(s, function visit(e) {
	(function () { return function visit(): unknown { return visit; }; })();
});`,
		},
		{
			name: "class declaration in a nested function shadowing the function name",
			body: `each(s, function visit(e) {
	(function () { class visit {} return visit; })();
});`,
		},
	}
}

// unrecordedShorthandCases holds callbacks whose shorthand properties read a value owned by another scope.
func unrecordedShorthandCases() []functionLocalCase {
	return []functionLocalCase{
		{
			name: "shorthand property of another variable",
			body: registerDecl + `each(s, function visit(e) {
	const other = e;
	register({ other });
});`,
		},
		{
			name: "shorthand property of a local shadowing the function name",
			body: registerDecl + `each(s, function visit(e) {
	{
		const visit = e;
		register({ visit });
	}
});`,
		},
		{
			name: "shorthand arguments property in a nested non-arrow function",
			body: registerDecl + `each(s, function (e) {
	(function () { register({ arguments }); })();
});`,
		},
	}
}

func TestAnalyze_RecordsFunctionLocalUsesOfAFunctionExpressionCallback(t *testing.T) {
	t.Parallel()
	checkFunctionLocal(t, slices.Concat(recordedFunctionLocalCases(), recordedNestedSelfReferenceCases()))
}

func TestAnalyze_RecordsNoFunctionLocalUsesOwnedByAnotherScope(t *testing.T) {
	t.Parallel()
	checkFunctionLocal(t, slices.Concat(unrecordedFunctionLocalCases(), unrecordedShadowingCases(), unrecordedShorthandCases()))
}

// classHeadCases holds class, member, and parameter decorators and computed member names, which run when the class is evaluated and see the callback's bindings.
func classHeadCases() []functionLocalCase {
	return []functionLocalCase{
		{
			name: "decorators belong to the callback",
			body: `declare function tag(value: unknown): (target: unknown, context: unknown) => void;
each(s, function (this: unknown, e) {
	@tag(this)
	class Local {
		@tag(arguments) method(): void {}
		@tag(new.target) other(): void {}
	}
});`,
			marks: []string{"this)", "arguments)", "new.target)"},
		},
		{
			name: "parameter decorators belong to the callback but parameter initializers do not",
			body: `declare function tag(value: unknown): (target: unknown, key: unknown, index: number) => void;
each(s, function (this: unknown, e) {
	class Local {
		// @ts-expect-error -- TypeScript rejects a parameter decorator without experimentalDecorators; it still evaluates in the callback
		constructor(@tag(this) first: unknown) {}
		// @ts-expect-error -- as above
		method(@tag(arguments) second: unknown, third = arguments): void {}
		// @ts-expect-error -- as above
		set value(@tag(new.target) fourth: unknown) {}
	}
});`,
			marks: []string{"this)", "arguments)", "new.target)"},
		},
		{
			name: "computed keys belong to the callback",
			body: `declare function key<K extends string>(value: unknown, name: K): K;
each(s, function visit(this: unknown, e) {
	class Local {
		[visit.name](): void {}
		[String(arguments.length)](): void {}
		[String(new.target)](): void {}
		// @ts-expect-error -- TypeScript rejects this in a class computed name; it still evaluates in the callback
		[key(this, "method")](): void {}
		// @ts-expect-error -- as above
		[key(this, "field")]: unknown;
	}
});`,
			marks: []string{"visit.name", "arguments.length", "new.target)", `this, "method"`, `this, "field"`},
		},
	}
}

// classStaticCases holds static blocks and static field initializers, which run when the class is evaluated with the class as this.
func classStaticCases() []functionLocalCase {
	return []functionLocalCase{
		{
			name: "static blocks bind their own this and new.target but see the self-reference",
			body: `each(s, function visit(e) {
	class Local {
		static {
			this;
			// @ts-expect-error -- TypeScript rejects new.target in a static block; it still evaluates there
			new.target;
			visit;
			const read = () => this;
			// @ts-expect-error -- as above
			const target = () => new.target;
		}
	}
});`,
			marks: []string{"visit;"},
		},
		{
			name: "static field initializers bind their own this and new.target but see the self-reference",
			body: `each(s, function visit(e) {
	class Local {
		static own = this;
		// @ts-expect-error -- TypeScript rejects new.target in a static field initializer; it still evaluates there
		static target = new.target;
		static self = visit;
		static read = () => this;
		// @ts-expect-error -- as above
		static readTarget = () => new.target;
	}
});`,
			marks: []string{"visit;"},
		},
	}
}

func TestAnalyze_WalksClassEvaluationCodeAsPartOfTheCallbackBody(t *testing.T) {
	t.Parallel()
	checkFunctionLocal(t, slices.Concat(classHeadCases(), classStaticCases()))
}
