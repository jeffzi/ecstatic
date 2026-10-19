package emit_test

import (
	"slices"
	"testing"

	"github.com/jeffzi/ecstatic/optimizer/internal/emit"
	"github.com/jeffzi/ecstatic/optimizer/internal/plan"
)

func TestRules_NameEveryRuleOnceInCatalogOrder(t *testing.T) {
	t.Parallel()

	rules := emit.Rules()

	names := make([]string, 0, len(rules))
	for _, r := range rules {
		names = append(names, r.Name())
	}
	if len(names) == 0 || names[0] != "mode-hoisted" || names[1] != "mode-realloc-safe" {
		t.Fatalf("Rules() names = %v, want the two modes first", names)
	}
	sorted := slices.Clone(names)
	slices.Sort(sorted)
	if got := len(slices.Compact(sorted)); got != len(names) || slices.Contains(names, "") {
		t.Errorf("Rules() names = %v, want %d distinct non-empty names", names, len(names))
	}
}

func TestFile_Applied_NamesTheRulesTheFileLoopsApplied(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name    string
		wantNot string
		want    []string
		mode    plan.Mode
	}{
		{
			name:    "a hoisted loop",
			mode:    plan.ModeHoisted,
			want:    []string{"mode-hoisted", "entity-id", "read-required-field", "write-required-field", "presence-optional"},
			wantNot: "mode-realloc-safe",
		},
		{
			name:    "a realloc-safe loop",
			mode:    plan.ModeReallocSafe,
			want:    []string{"mode-realloc-safe", "entity-id", "read-required-field", "write-required-field", "presence-optional"},
			wantNot: "mode-hoisted",
		},
	}
	p := loadProject(t, map[string]string{caseFile(0): casePrelude + modeSource})
	debug := p.debugOf(t)
	// The rows run one at a time: they rewrite one program, whose checker is not safe for concurrent use.
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			applied := p.rewrite(t, caseFile(0), debug, tt.mode).applied

			for _, name := range tt.want {
				if !slices.Contains(applied, name) {
					t.Errorf("Applied() = %v, want it to name %q", applied, name)
				}
			}
			if slices.Contains(applied, tt.wantNot) {
				t.Errorf("Applied() = %v, want it not to name %q", applied, tt.wantNot)
			}
		})
	}
}

// nestedBindingsSource uses `this`, `arguments`, `super`, `new.target`, a label, and `throw`, and declares block-scoped
// bindings, only inside code the callback nests that binds its own: a function expression, a class method, and a
// class static block.
const nestedBindingsSource = `class Base {
    name(): string {
        return "base";
    }
}
export class Walker {
    walk(): unknown[] {
        const seen: unknown[] = [];
        each(register(createWorld(), Mover), (e) => {
            seen.push(e.Position.x);
            seen.push(function (this: unknown) {
                let held = 1;
                stop: for (;;) {
                    break stop;
                }
                if (held < 0) throw new RangeError("never");
                return [this, arguments.length, new.target, held];
            });
            seen.push(class extends Base {
                static {
                    seen.push(this);
                }
                override name(): string {
                    const named = super.name();
                    return named + String(this);
                }
            });
        });
        return seen;
    }
}
`

// ownBindingsSource uses `this`, `arguments`, `super`, `new.target`, a label, and `throw`, and declares a block-scoped
// binding, in the arrow callback's own code, and reads `this` again through an arrow nested in it, which sees the same
// binding.
const ownBindingsSource = `class Base {
    name(): string {
        return "base";
    }
}
export class Walker extends Base {
    readonly seen: unknown[] = [];
    constructor(...extra: number[]) {
        super();
        each(register(createWorld(), Mover), (e) => {
            const x = e.Position.x;
            mark: {
                if (x < 0) break mark;
            }
            if (x < -1) throw new RangeError("negative");
            this.seen.push(this, arguments.length, super.name(), new.target, extra, x, () => this);
        });
    }
}
`

// bodyRules lists the rules a callback body applies by what its own code uses and declares.
func bodyRules() []string {
	return []string{"this", "arguments", "super", "new-target", "block-scoped-declaration", "user-label", "throw"}
}

// moverEach opens an each call over a fresh Mover storage, whose callback the case closes.
const moverEach = "each(register(createWorld(), Mover), (e) => {\n"

// appliedCase is a case file whose loops apply the rules want names and not those wantNot names.
type appliedCase struct {
	name    string
	source  string
	want    []string
	wantNot []string
}

// bindingRuleCases are callback bodies whose uses and declarations apply the body rules or, nested in code that
// binds its own, do not.
func bindingRuleCases() []appliedCase {
	return []appliedCase{
		{name: "uses in the callback's own code", source: ownBindingsSource, want: bodyRules()},
		{name: "uses only inside nested functions, class methods, and static blocks", source: nestedBindingsSource, wantNot: bodyRules()},
	}
}

// relationRuleCases are callback bodies whose field uses apply the relation data field rule or not.
func relationRuleCases() []appliedCase {
	return []appliedCase{
		{
			name: "a relation slot's data fields",
			source: "export const seen: unknown[] = [];\nconst storage = register(createWorld(), Tethered);\n" +
				"each(storage, (e) => {\n    e.Tether.slack += 1;\n    seen.push(e.Leash?.length);\n});\n",
			want: []string{"relation-data-field"},
		},
		{
			name:    "a component slot's fields only",
			source:  "export const seen: unknown[] = [];\n" + moverEach + "    seen.push(e.Position.x);\n});\n",
			wantNot: []string{"relation-data-field"},
		},
	}
}

// returnRuleCases are callback bodies whose returns apply the rules they name.
func returnRuleCases() []appliedCase {
	return []appliedCase{
		{
			name:    "a returned object literal",
			source:  moverEach + "    return { x: e.Position.x };\n});\n",
			want:    []string{"return-object-literal"},
			wantNot: []string{"return-value", "return-function-expression"},
		},
		{
			name:    "a returned value that starts with an object literal",
			source:  moverEach + "    return { x: e.Position.x }.x;\n});\n",
			want:    []string{"return-object-literal"},
			wantNot: []string{"return-value"},
		},
		{
			name:    "a returned function expression",
			source:  moverEach + "    return function () {\n        return 1;\n    };\n});\n",
			want:    []string{"return-function-expression"},
			wantNot: []string{"return-value", "return-object-literal"},
		},
		{
			name:    "a returned parenthesized object literal",
			source:  moverEach + "    return ({ x: e.Position.x });\n});\n",
			want:    []string{"return-value"},
			wantNot: []string{"return-object-literal"},
		},
	}
}

// outerRuleCases are callback bodies whose references to bindings outside them apply the rules they name.
func outerRuleCases() []appliedCase {
	return []appliedCase{
		{
			name:   "outer bindings named like the loop's own",
			source: "const n = 2;\nconst i = 3;\nexport const seen: number[] = [];\n" + moverEach + "    seen.push(e.Position.x * n + i);\n});\n",
			want:   []string{"outer-binding"},
		},
		{
			name:    "a body binding named like the loop's own",
			source:  "export const seen: number[] = [];\n" + moverEach + "    const i = 3;\n    seen.push(e.Position.x + i);\n});\n",
			wantNot: []string{"outer-binding"},
		},
		{
			name:    "an outer binding named unlike the loop's own",
			source:  "const k = 3;\nexport const seen: number[] = [];\n" + moverEach + "    seen.push(e.Position.x + k);\n});\n",
			wantNot: []string{"outer-binding"},
		},
		{
			name:   "a read of an outer let declared after the call",
			source: deadZoneSource("seen.push(e.Position.x, later);", "let later = 1;"),
			want:   []string{"outer-let-dead-zone"},
		},
		{
			name:    "a read of an outer let declared before the call",
			source:  "let earlier = 1;\nearlier += 1;\n" + deadZoneSource("seen.push(e.Position.x, earlier);", ""),
			wantNot: []string{"outer-let-dead-zone"},
		},
		{
			name:    "a read of an outer let declared after the call, inside a nested function",
			source:  deadZoneSource("seen.push(e.Position.x, () => later);", "let later = 1;"),
			wantNot: []string{"outer-let-dead-zone"},
		},
		{
			name:    "a read of an outer var declared after the call",
			source:  deadZoneSource("seen.push(e.Position.x, later);", "var later = 1;"),
			wantNot: []string{"outer-let-dead-zone"},
		},
	}
}

// deadZoneSource is a function that runs body as an each callback inside a try statement, then declares after.
func deadZoneSource(body, after string) string {
	return "export function run(): unknown[] {\n    const seen: unknown[] = [];\n    try {\n        " + moverEach +
		"            " + body + "\n        });\n    } catch {\n        seen.push(\"thrown\");\n    }\n    " + after +
		"\n    return seen;\n}\n"
}

func TestFile_Applied_NamesTheRulesTheBodyApplies(t *testing.T) {
	t.Parallel()
	for _, tt := range slices.Concat(bindingRuleCases(), relationRuleCases(), returnRuleCases(), outerRuleCases()) {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			p := loadProject(t, map[string]string{caseFile(0): casePrelude + tt.source})

			applied := p.rewrite(t, caseFile(0), p.debugOf(t), 0).applied

			for _, name := range tt.want {
				if !slices.Contains(applied, name) {
					t.Errorf("Applied() = %v, want it to name %q", applied, name)
				}
			}
			for _, name := range tt.wantNot {
				if slices.Contains(applied, name) {
					t.Errorf("Applied() = %v, want it not to name %q", applied, name)
				}
			}
		})
	}
}
