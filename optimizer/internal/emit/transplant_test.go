package emit_test

import (
	"slices"
	"testing"
)

// threeMovers opens a scenario with a Mover storage of three rows whose Position.x is 1, 2, then 3.
const threeMovers = `export function scenario(): unknown {
    const movers = register(createWorld(), Mover);
    spawn(movers, { Position: { x: 1, y: 0 }, Velocity: { dx: 0, dy: 0 } });
    spawn(movers, { Position: { x: 2, y: 0 }, Velocity: { dx: 0, dy: 0 } });
    spawn(movers, { Position: { x: 3, y: 0 }, Velocity: { dx: 0, dy: 0 } });
`

// returnCases holds scenarios whose body returns from the callback.
func returnCases() []runCase {
	return []runCase{
		{
			name: "return; ends the row and the loop runs the next one",
			source: threeMovers + `    const seen: number[] = [];
    each(movers, (e) => {
        if (e.Position.x === 2) {
            return;
        }
        seen.push(e.Position.x);
    });
    return seen;
}
`,
			want: `[3,1]`,
		},
		{
			name: "return expr runs expr, an object-literal or function-expression value included",
			source: threeMovers + `    const trace: unknown[] = [];
    const note = (value: unknown): unknown => {
        trace.push(value);
        return value;
    };
    each(movers, (e) => {
        if (e.Position.x === 1) {
            return { at: note(e.Position.x), twice: note(e.Position.x * 2) };
        }
        if (e.Position.x === 2) {
            return function () {
                trace.push("never");
            };
        }
        return note(e.Position.x * 10);
    });
    return trace;
}
`,
			want: `[30,1,2]`,
		},
		{
			name: "a returned value reading a disabled optional throws as the runtime does",
			source: `export function scenario(): unknown {
    const { storage } = guarded();
    const trace: unknown[] = [];
    try {
        each(storage, (e) => {
            trace.push(e.Position.x);
            return e.Shield!.hp;
        });
    } catch (error) {
        trace.push((error as Error).constructor.name);
    }
    return trace;
}
`,
			want: `[2,"TypeError"]`,
		},
	}
}

// nestedReturnCases holds scenarios whose body returns from inside a statement that is not the body root.
func nestedReturnCases() []runCase {
	return []runCase{
		{
			name: "a return under a nested loop or switch continues the row loop, not the inner statement",
			source: threeMovers + `    const seen: string[] = [];
    each(movers, (e) => {
        for (let k = 0; k < 3; k++) {
            if (k === 1 && e.Position.x === 2) {
                return;
            }
            seen.push(e.Position.x + ":" + k);
        }
        switch (e.Position.x) {
            case 3:
                return;
            default:
                seen.push(e.Position.x + ":end");
        }
        seen.push(e.Position.x + ":after");
    });
    return seen;
}
`,
			want: `["3:0","3:1","3:2","2:0","1:0","1:1","1:2","1:end","1:after"]`,
		},
		{
			name: "a return inside try … finally still runs the finally",
			source: threeMovers + `    const seen: string[] = [];
    each(movers, (e) => {
        try {
            while (true) {
                if (e.Position.x === 2) {
                    return;
                }
                break;
            }
            seen.push("try " + e.Position.x);
        } finally {
            seen.push("finally " + e.Position.x);
        }
        seen.push("after " + e.Position.x);
    });
    return seen;
}
`,
			want: `["try 3","finally 3","after 3","finally 2","try 1","finally 1","after 1"]`,
		},
	}
}

// bodyFormCases holds scenarios on nested functions' returns and expression-bodied callbacks.
func bodyFormCases() []runCase {
	return []runCase{
		{
			name: "returns in nested functions are untouched",
			source: threeMovers + `    const seen: number[] = [];
    each(movers, (e) => {
        const double = (v: number): number => {
            return v * 2;
        };
        function triple(v: number): number {
            return v * 3;
        }
        const half = {
            of(v: number): number {
                return v / 2;
            },
        };
        seen.push(double(e.Position.x), triple(e.Position.x), half.of(e.Position.x));
    });
    return seen;
}
`,
			want: `[6,9,1.5,4,6,1,2,3,0.5]`,
		},
		{
			name: "an expression-bodied callback's expression runs once per row",
			source: threeMovers + `    const seen: number[] = [];
    each(movers, (e) => seen.push(e.Position.x * 10));
    return seen;
}
`,
			want: `[30,20,10]`,
		},
	}
}

// declarationCases holds scenarios whose body declares bindings.
func declarationCases() []runCase {
	return []runCase{
		{
			name: "body let, const, class, and function declarations are fresh on every row, closures capturing that row's",
			source: threeMovers + `    const readers: (() => unknown)[] = [];
    each(movers, (e) => {
        const x = e.Position.x;
        let doubled = x * 2;
        class Tag {
            static value = x;
        }
        function read(): unknown {
            return [x, doubled, Tag.value];
        }
        readers.push(read, () => doubled);
        doubled += 100;
    });
    return readers.map((reader) => reader());
}
`,
			want: `[[3,106,3],106,[2,104,2],104,[1,102,1],102]`,
		},
		{
			name: "a body var is fresh on every row",
			source: threeMovers + `    const seen: unknown[] = [];
    each(movers, (e) => {
        seen.push(typeof carried);
        var carried: number | undefined = e.Position.x;
        var unset: number | undefined;
        seen.push(unset ?? "fresh");
        unset = carried;
        var twice = e.Position.x;
        var twice = twice * 10;
        for (var k = 0; k < 2; k++) {}
        seen.push(twice, k);
    });
    return seen;
}
`,
			want: `["undefined","fresh",30,2,"undefined","fresh",20,2,"undefined","fresh",10,2]`,
		},
		{
			name: "a body var never hoists into the enclosing function",
			source: `export function scenario(): unknown {
    let marker = "outer";
    let entry = "outer entry";
    const movers = register(createWorld(), Mover);
    spawn(movers, { Position: { x: 1, y: 0 }, Velocity: { dx: 0, dy: 0 } });
    each(movers, (e) => {
        var marker = e.id;
        for (var entry of [e.id]) {
            void entry;
        }
        void marker;
    });
    return [marker, entry];
}
`,
			want: `["outer","outer entry"]`,
		},
	}
}

// varPatternCases holds scenarios whose body var destructures.
func varPatternCases() []runCase {
	return []runCase{
		{
			name: "a destructuring body var is fresh on every row, closures capturing that row's, nested and array patterns, rests, and defaults included",
			source: threeMovers + `    const readers: (() => unknown)[] = [];
    const parts = (x: number): { a: number; b: number; p: { q?: number }; r: number[] } =>
        ({ a: x, b: x * 10, p: x === 2 ? { q: 7 } : {}, r: [x, 0] });
    each(movers, (e) => {
        var { a, b: c } = parts(e.Position.x);
        var { p: { q = e.Position.x + 100 }, r: [s, , t = 9] } = parts(e.Position.x);
        var [u = -1, ...more] = e.Position.x === 2 ? [] : [e.Position.x, 7, 8];
        var { a: first, ...others } = parts(e.Position.x);
        readers.push(() => [a, c, q, s, t, u, more.length, first, Object.keys(others).length]);
        var a = a * 2;
    });
    return readers.map((reader) => reader());
}
`,
			want: `[[6,30,103,3,9,3,2,3,3],[4,20,7,2,9,-1,0,2,3],[2,10,101,1,9,1,2,1,3]]`,
		},
		{
			name: "a destructuring body var never hoists into the enclosing function",
			source: `export function scenario(): unknown {
    let a = "outer a";
    let q = "outer q";
    let u = "outer u";
    const movers = register(createWorld(), Mover);
    spawn(movers, { Position: { x: 1, y: 0 }, Velocity: { dx: 0, dy: 0 } });
    each(movers, (e) => {
        var { a, p: { q } } = { a: e.id, p: { q: e.id } };
        var [u] = [e.id];
        void a;
        void q;
        void u;
    });
    return [a, q, u];
}
`,
			want: `["outer a","outer q","outer u"]`,
		},
	}
}

// varSharedNameCases holds scenarios whose body var shares its name with a body function.
func varSharedNameCases() []runCase {
	return []runCase{
		{
			name: "a body var sharing its name with a body function is the function's binding, as in the callback",
			source: threeMovers + `    const seen: unknown[] = [];
    each(movers, (e) => {
        seen.push(typeof f, typeof g);
        const x = e.Position.x;
        // @ts-expect-error -- a var and a function sharing a name are one binding in a function body
        var f = (): number => x;
        // @ts-expect-error -- the function half of the binding f shares with the var above
        function f(): number {
            return -1;
        }
        // @ts-expect-error -- a var without an initializer leaves the binding it shares the function's
        var g: () => number;
        // @ts-expect-error -- the function half of the binding g shares with the var above
        function g(): number {
            return x * 10;
        }
        seen.push(f(), g());
        {
            // @ts-expect-error -- a var in a nested block joins the binding of the body's function f
            var f = (): number => x * 100;
        }
        seen.push(f());
    });
    return seen;
}
`,
			want: `["function","function",3,30,300,"function","function",2,20,200,"function","function",1,10,100]`,
		},
	}
}

// bindingSource calls each from a method, in an arrow callback with a type annotation that reads this, arguments,
// and super.
const bindingSource = `class Named {
    name(): string {
        return "base";
    }
}

class Collector extends Named {
    readonly tag = "collector";

    override name(): string {
        return "collector";
    }

    collect(movers: Storage<typeof Mover>, ...extra: number[]): unknown[] {
        const seen: unknown[] = [];
        each(movers, (e: { readonly id: number; readonly Position: { readonly x: number } }) => {
            seen.push(this.tag, arguments.length, super.name(), extra.length, e.Position.x);
        });
        return seen;
    }
}

export function scenario(): unknown {
    const movers = register(createWorld(), Mover);
    spawn(movers, { Position: { x: 1, y: 0 }, Velocity: { dx: 0, dy: 0 } });
    return new Collector().collect(movers, 7, 8);
}
`

// controlFlowCases holds scenarios over the enclosing function's bindings, labels, and the order of evaluation.
func controlFlowCases() []runCase {
	return []runCase{
		{
			name:   "this, arguments, and super in an annotated arrow callback keep the enclosing function's",
			source: bindingSource,
			want:   `["collector",3,"base",2,1]`,
		},
		{
			name: "user labels, break, and continue behave as written beside a return that continues the row",
			source: threeMovers + `    const seen: string[] = [];
    each(movers, (e) => {
        row: for (let a = 0; a < 3; a++) {
            for (let b = 0; b < 3; b++) {
                if (b === 1) continue row;
                if (a === 2) break row;
                seen.push(e.Position.x + ":" + a + b);
            }
        }
        loop: {
            if (e.Position.x === 2) break loop;
            seen.push(e.Position.x + ":block");
        }
        for (let k = 0; k < 2; k++) {
            if (k === 0) continue;
            if (e.Position.x === 1) return;
            seen.push(e.Position.x + ":k" + k);
        }
    });
    return seen;
}
`,
			want: `["3:00","3:10","3:block","3:k1","2:00","2:10","2:k1","1:00","1:10","1:block"]`,
		},
		{
			name: "reading an outer let in its temporal dead zone throws at the same point",
			source: threeMovers + `    const seen: unknown[] = [];
    try {
        each(movers, (e) => {
            seen.push(e.Position.x);
            seen.push(later);
        });
    } catch (error) {
        seen.push((error as Error).constructor.name);
    }
    let later = "late";
    seen.push(later);
    return seen;
}
`,
			want: `[3,"ReferenceError","late"]`,
		},
	}
}

// enclosingLabelCases holds scenarios whose body declares a label that a statement enclosing the call also declares.
func enclosingLabelCases() []runCase {
	return []runCase{
		{
			name: "a body label that an enclosing statement also declares keeps its break and continue on the body's statement",
			source: threeMovers + `    const seen: string[] = [];
    outer: for (let pass = 0; pass < 2; pass++) {
        each(movers, (e) => {
            outer: for (let a = 0; a < 3; a++) {
                for (let b = 0; b < 3; b++) {
                    if (b === 1) continue outer;
                    if (a === 1) break outer;
                    seen.push(pass + ":" + e.Position.x + ":" + a + b);
                }
            }
            const nested = (): string => {
                outer: for (;;) break outer;
                return "nested";
            };
            seen.push(nested());
        });
        if (pass === 0) continue outer;
        break outer;
    }
    return seen;
}
`,
			want: `["0:3:00","nested","0:2:00","nested","0:1:00","nested","1:3:00","nested","1:2:00","nested","1:1:00","nested"]`,
		},
	}
}

func TestFile_Inline_TransplantsTheCallbackBodyAsTheRuntimeRunsIt(t *testing.T) {
	t.Parallel()
	cases := slices.Concat(returnCases(), nestedReturnCases(), bodyFormCases(), declarationCases(), varPatternCases(), varSharedNameCases(),
		controlFlowCases(), enclosingLabelCases())

	checkScenarios(t, cases, []bool{false})
}
