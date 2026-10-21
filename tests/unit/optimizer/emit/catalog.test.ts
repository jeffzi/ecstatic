import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { inCatalogOrder, type Rule, RULES } from "../../../../src/plugin/optimizer/emit/catalog.js";
import type { Mode } from "../../../../src/plugin/optimizer/plan.js";
import { closeProject, SPAWN_TIMEOUT_MS } from "../project.js";
import { CASE_PRELUDE, EmitProject, MODE_SOURCE, rewriteAt } from "./emit-project.js";

let project: EmitProject;

beforeAll(async () => {
  project = await EmitProject.open();
}, SPAWN_TIMEOUT_MS);

afterAll(() => closeProject(project.session));

/** Declares the exported array of numbers a case's callbacks push to. */
const SEEN_NUMBERS = "export const seen: number[] = [];\n";

/** Declares the exported array of anything a case's callbacks push to. */
const SEEN_UNKNOWN = "export const seen: unknown[] = [];\n";

/** Opens an each call over a fresh Mover storage, whose callback the case closes. */
const MOVER_EACH = "each(register(createWorld(), Mover), (e) => {\n";

/** An each call over a Guarded storage whose callback runs `lines`, one statement per entry. */
function guardedEach(...lines: readonly string[]): string {
  const body = lines.map((line) => `    ${line}\n`).join("");
  return `${SEEN_UNKNOWN}const { storage } = guarded();\neach(storage, (e) => {\n${body}});\n`;
}

/**
 * Uses `this`, `arguments`, `super`, `new.target`, a label, and `throw`, and declares a
 * block-scoped binding, in the arrow callback's own code, and reads `this` again through a nested
 * arrow, which sees the same binding.
 */
const OWN_BINDINGS_SOURCE = `class Base {
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
`;

/**
 * Uses `this`, `arguments`, `super`, `new.target`, a label, and `throw`, and declares
 * block-scoped bindings, only inside code the callback nests that binds its own: a function
 * expression, a class method, and a class static block.
 */
const NESTED_BINDINGS_SOURCE = `class Base {
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
`;

/** The rules a callback body applies by what its own code uses and declares. */
const BODY_RULES: readonly Rule[] = [
  "this",
  "arguments",
  "super",
  "new-target",
  "block-scoped-declaration",
  "user-label",
  "throw",
];

/** The rules {@link MODE_SOURCE} applies in either mode, beside the mode's own. */
const MODE_SOURCE_RULES: readonly Rule[] = [
  "entity-id",
  "read-required-field",
  "write-required-field",
  "presence-optional",
];

/**
 * An each call over a Mover storage whose arrow callback writes a required field, then one over a
 * Guarded storage whose function callback reads an optional field through an optional chain.
 */
const TWO_LOOPS_SOURCE = `${SEEN_UNKNOWN}each(register(createWorld(), Mover), (e) => {
    e.Position.x = 1;
});
const { storage } = guarded();
each(storage, function (e) {
    seen.push(e.Shield?.hp);
});
`;

/** Rules the first loop of {@link TWO_LOOPS_SOURCE} applies and the second does not. */
const FIRST_LOOP_RULES: readonly Rule[] = ["write-required-field", "callback-arrow"];

/** Rules the second loop of {@link TWO_LOOPS_SOURCE} applies and the first does not. */
const SECOND_LOOP_RULES: readonly Rule[] = ["optional-chain-read", "callback-function"];

/** A function that runs `body` as an each callback inside a try statement, then declares `after`. */
function deadZoneSource(body: string, after: string): string {
  return [
    "export function run(): unknown[] {",
    "    const seen: unknown[] = [];",
    "    try {",
    `        ${MOVER_EACH}            ${body}`,
    "        });",
    "    } catch {",
    '        seen.push("thrown");',
    "    }",
    `    ${after}`,
    "    return seen;",
    "}",
    "",
  ].join("\n");
}

describe("RULES", () => {
  it("names every rule of the rewrite catalog in catalog order", () => {
    expect(RULES).toStrictEqual([
      "mode-hoisted",
      "mode-realloc-safe",
      "entity-id",
      "read-required-field",
      "read-optional-field",
      "read-boolean-field",
      "write-required-field",
      "write-optional-field",
      "write-boolean-field",
      "boolean-assignment-value",
      "update-field",
      "relation-data-field",
      "non-null-slot",
      "optional-chain-read",
      "presence-optional",
      "presence-required",
      "compare-null-strict-equal",
      "compare-null-strict-not-equal",
      "coalesce-optional",
      "coalesce-required",
      "required-tag",
      "optional-tag",
      "alias",
      "destructure-slot",
      "destructure-parameter",
      "destructure-parameter-nested",
      "destructure-id",
      "destructure-view",
      "destructure-view-nested",
      "destructure-optional-slot",
      "destructure-optional-tag",
      "destructure-default-typed",
      "destructure-default-plain",
      "callback-arrow",
      "callback-function",
      "callback-without-parameter",
      "callback-typed-parameter",
      "return-void",
      "return-value",
      "return-object-literal",
      "return-function-expression",
      "return-class-expression",
      "return-labeled",
      "return-in-finally",
      "return-in-nested-function",
      "expression-body",
      "outer-binding",
      "block-scoped-declaration",
      "closure",
      "outer-let-dead-zone",
      "this",
      "arguments",
      "new-target",
      "super",
      "var-to-let",
      "user-label",
      "user-label-renamed",
      "throw",
    ]);
  });

  it("names each rule once", () => {
    const distinct = new Set(RULES);

    expect(distinct.size).toBe(RULES.length);
  });
});

describe("inCatalogOrder", () => {
  it.each<{ name: string; applied: Rule[]; expected: Rule[] }>([
    { name: "no rule applied", applied: [], expected: [] },
    {
      name: "rules recorded out of catalog order",
      applied: ["throw", "entity-id", "mode-realloc-safe", "alias"],
      expected: ["mode-realloc-safe", "entity-id", "alias", "throw"],
    },
    {
      name: "every rule applied",
      applied: [...RULES].toReversed(),
      expected: [...RULES],
    },
  ])("lists the applied rules in catalog order for $name", ({ applied, expected }) => {
    const ordered = inCatalogOrder(new Set(applied));

    expect(ordered).toStrictEqual(expected);
  });
});

describe("EmitFile", () => {
  describe("applied", () => {
    it.each<{ mode: Mode; expected: readonly Rule[]; absent: Rule }>([
      {
        mode: "hoisted",
        expected: ["mode-hoisted", ...MODE_SOURCE_RULES],
        absent: "mode-realloc-safe",
      },
      {
        mode: "realloc-safe",
        expected: ["mode-realloc-safe", ...MODE_SOURCE_RULES],
        absent: "mode-hoisted",
      },
    ])(
      "names the rules a $mode loop applied, in catalog order",
      async ({ mode, expected, absent }) => {
        const { applied } = await project.rewrite(CASE_PRELUDE + MODE_SOURCE, { mode });

        expect(applied).toStrictEqual(inCatalogOrder(new Set(applied)));
        expect(applied).toStrictEqual(expect.arrayContaining([...expected]));
        expect(applied).not.toContain(absent);
      },
    );

    it.each<{ name: string; source: string; expected?: readonly Rule[]; absent?: readonly Rule[] }>(
      [
        {
          name: "uses in the callback's own code",
          source: OWN_BINDINGS_SOURCE,
          expected: BODY_RULES,
        },
        {
          name: "uses only inside nested functions, class methods, and static blocks",
          source: NESTED_BINDINGS_SOURCE,
          absent: BODY_RULES,
        },
        {
          name: "a relation slot's data fields",
          source: [
            "export const seen: unknown[] = [];",
            "const storage = register(createWorld(), Tethered);",
            "each(storage, (e) => {",
            "    e.Tether.slack += 1;",
            "    seen.push(e.Leash?.length);",
            "});",
            "",
          ].join("\n"),
          expected: ["relation-data-field"],
        },
        {
          name: "a required field read through a non-null slot",
          source: guardedEach("seen.push(e.Position!.x);"),
          expected: ["read-required-field", "non-null-slot"],
          absent: ["read-optional-field"],
        },
        {
          name: "a required field read through a plain slot",
          source: guardedEach("seen.push(e.Position.x);"),
          expected: ["read-required-field"],
          absent: ["non-null-slot", "read-optional-field", "read-boolean-field"],
        },
        {
          name: "an optional field read",
          source: guardedEach("if (e.Shield) seen.push(e.Shield.level);"),
          expected: ["read-optional-field", "presence-optional"],
          absent: ["read-required-field", "read-boolean-field"],
        },
        {
          name: "a boolean field read",
          source: guardedEach("seen.push(e.Flags.on);"),
          expected: ["read-required-field", "read-boolean-field"],
        },
        {
          name: "a boolean field write whose value is unused",
          source: guardedEach("e.Flags.on = false;"),
          expected: ["write-required-field", "write-boolean-field"],
          absent: ["boolean-assignment-value", "write-optional-field"],
        },
        {
          name: "a boolean field write whose value is used",
          source: guardedEach("seen.push((e.Flags.on = false));"),
          expected: ["write-boolean-field", "boolean-assignment-value"],
        },
        {
          name: "an optional field write through a non-null slot",
          source: guardedEach("e.Shield!.hp = 1;"),
          expected: ["write-optional-field", "non-null-slot"],
          absent: ["write-required-field", "write-boolean-field"],
        },
        {
          name: "a field update through a non-null slot",
          source: guardedEach("e.Shield!.hp++;"),
          expected: ["update-field", "non-null-slot"],
        },
        {
          name: "a prefix field update through a plain slot",
          source: guardedEach("++e.Position.x;"),
          expected: ["update-field"],
          absent: ["non-null-slot"],
        },
        {
          name: "an optional chain on an optional slot",
          source: guardedEach("seen.push(e.Shield?.hp);"),
          expected: ["optional-chain-read"],
        },
        {
          name: "an optional chain on a required slot",
          source: guardedEach("seen.push(e.Position?.x);"),
          absent: ["optional-chain-read"],
        },
        {
          name: "a required slot's presence test",
          source: guardedEach("if (e.Position) seen.push(1);"),
          expected: ["presence-required"],
          absent: ["presence-optional"],
        },
        {
          name: "an optional slot compared with undefined and loosely with null",
          source: guardedEach("seen.push(e.Shield === undefined, e.Shield == null);"),
          expected: ["presence-optional"],
          absent: ["compare-null-strict-equal", "compare-null-strict-not-equal"],
        },
        {
          name: "a slot compared strictly with null",
          source: guardedEach("seen.push(e.Shield === null);"),
          expected: ["compare-null-strict-equal"],
          absent: ["compare-null-strict-not-equal", "presence-optional"],
        },
        {
          name: "a slot compared strictly as not null",
          source: guardedEach("seen.push(e.Shield !== null);"),
          expected: ["compare-null-strict-not-equal"],
          absent: ["compare-null-strict-equal", "presence-optional"],
        },
        {
          name: "an optional slot coalesced in a test",
          source: guardedEach("if (e.Shield ?? false) seen.push(1);"),
          expected: ["coalesce-optional"],
          absent: ["coalesce-required"],
        },
        {
          name: "a required slot coalesced in a test",
          source: guardedEach("if (e.Position ?? false) seen.push(1);"),
          expected: ["coalesce-required"],
          absent: ["coalesce-optional"],
        },
        {
          name: "a required tag",
          source: guardedEach("seen.push(e.Stunned);"),
          expected: ["required-tag"],
          absent: ["optional-tag"],
        },
        {
          name: "an optional tag",
          source: guardedEach("seen.push(e.Boost);"),
          expected: ["optional-tag"],
          absent: ["required-tag"],
        },
        {
          name: "an alias of a slot",
          source: guardedEach("const shield = e.Shield;", "seen.push(shield?.hp);"),
          expected: ["alias"],
          absent: ["non-null-slot"],
        },
        {
          name: "an alias of a non-null slot",
          source: guardedEach("const shield = e.Shield!;", "seen.push(shield.hp);"),
          expected: ["alias", "non-null-slot"],
        },
        {
          name: "a required slot destructured in the body",
          source: guardedEach("const { x } = e.Position;", "seen.push(x);"),
          expected: ["destructure-slot"],
          absent: ["destructure-optional-slot", "destructure-view", "destructure-default-typed"],
        },
        {
          name: "an optional slot destructured in the body",
          source: guardedEach("const { hp } = e.Shield!;", "seen.push(hp);"),
          expected: ["destructure-slot", "destructure-optional-slot"],
        },
        {
          name: "the view destructured in the body",
          source: guardedEach(
            "const { id, Position, Flags: { on }, Stunned, Boost } = e;",
            "seen.push(id, Position.x, on, Stunned, Boost);",
          ),
          expected: [
            "destructure-view",
            "destructure-view-nested",
            "destructure-id",
            "destructure-optional-tag",
          ],
          absent: ["destructure-slot", "destructure-parameter", "destructure-parameter-nested"],
        },
        {
          name: "the view destructured in the callback's parameter",
          source: [
            "export const seen: unknown[] = [];",
            "const { storage } = guarded();",
            "each(storage, ({ id, Position: p, Flags: { on } }) => {",
            "    seen.push(id, p.x, on);",
            "});",
            "",
          ].join("\n"),
          expected: ["destructure-parameter", "destructure-parameter-nested", "destructure-id"],
          absent: ["destructure-view", "destructure-view-nested", "destructure-optional-tag"],
        },
        {
          name: "a field default on a typed-array column",
          source: guardedEach("const { x = 1 } = e.Position;", "seen.push(x);"),
          expected: ["destructure-default-typed"],
          absent: ["destructure-default-plain"],
        },
        {
          name: "a field default on a plain-array column",
          source: [
            "export const seen: unknown[] = [];",
            "const { storage } = marked();",
            "each(storage, (e) => {",
            "    if (e.Mark) {",
            "        const { first = 1 } = e.Mark;",
            "        seen.push(first);",
            "    }",
            "});",
            "",
          ].join("\n"),
          expected: ["destructure-default-plain"],
          absent: ["destructure-default-typed"],
        },
        {
          name: "a component slot's fields only",
          source: `${SEEN_UNKNOWN}${MOVER_EACH}    seen.push(e.Position.x);\n});\n`,
          absent: ["relation-data-field"],
        },
        {
          name: "a returned object literal",
          source: `${MOVER_EACH}    return { x: e.Position.x };\n});\n`,
          expected: ["return-object-literal"],
          absent: ["return-value", "return-function-expression"],
        },
        {
          name: "a returned value that starts with an object literal",
          source: `${MOVER_EACH}    return { x: e.Position.x }.x;\n});\n`,
          expected: ["return-object-literal"],
          absent: ["return-value"],
        },
        {
          name: "a returned function expression",
          source: `${MOVER_EACH}    return function () {\n        return 1;\n    };\n});\n`,
          expected: ["return-function-expression"],
          absent: ["return-value", "return-object-literal"],
        },
        {
          name: "a returned class expression",
          source: `${MOVER_EACH}    return class {\n        static x = 1;\n    };\n});\n`,
          expected: ["return-class-expression"],
          absent: ["return-value", "return-object-literal", "return-function-expression"],
        },
        {
          name: "an expression body that starts with a class expression",
          source: `each(register(createWorld(), Mover), (e) => class {\n    static x = e.Position.x;\n});\n`,
          expected: ["expression-body"],
          absent: ["return-class-expression", "return-value"],
        },
        {
          name: "a returned parenthesized object literal",
          source: `${MOVER_EACH}    return ({ x: e.Position.x });\n});\n`,
          expected: ["return-value"],
          absent: ["return-object-literal"],
        },
        {
          name: "an arrow callback with a block body and an untyped parameter",
          source: `${SEEN_NUMBERS}${MOVER_EACH}    seen.push(e.Position.x);\n});\n`,
          expected: ["callback-arrow"],
          absent: [
            "callback-function",
            "callback-without-parameter",
            "callback-typed-parameter",
            "expression-body",
          ],
        },
        {
          name: "a function-expression callback",
          source: `${SEEN_NUMBERS}each(register(createWorld(), Mover), function (e) {\n    seen.push(e.Position.x);\n});\n`,
          expected: ["callback-function"],
          absent: ["callback-arrow"],
        },
        {
          name: "a callback without a parameter",
          source: `${SEEN_NUMBERS}each(register(createWorld(), Mover), () => {\n    seen.push(1);\n});\n`,
          expected: ["callback-arrow", "callback-without-parameter"],
          absent: ["callback-typed-parameter"],
        },
        {
          name: "a callback whose parameter has a type annotation",
          source: `${SEEN_NUMBERS}each(register(createWorld(), Mover), (e: { readonly Position: { readonly x: number } }) => {\n    seen.push(e.Position.x);\n});\n`,
          expected: ["callback-typed-parameter"],
          absent: ["callback-without-parameter"],
        },
        {
          name: "an expression-bodied callback",
          source: `${SEEN_NUMBERS}each(register(createWorld(), Mover), (e) => seen.push(e.Position.x));\n`,
          expected: ["callback-arrow", "expression-body"],
        },
        {
          name: "a return without a value at the body root",
          source: `${MOVER_EACH}    if (e.Position.x > 1) return;\n});\n`,
          expected: ["return-void"],
          absent: ["return-labeled", "return-in-finally", "return-in-nested-function"],
        },
        {
          name: "a return under an inner loop",
          source: `${MOVER_EACH}    for (let k = 0; k < 2; k++) {\n        if (k === e.Position.x) return;\n    }\n});\n`,
          expected: ["return-void", "return-labeled"],
        },
        {
          name: "a return under a switch",
          source: `${MOVER_EACH}    switch (e.Position.x) {\n        case 1:\n            return;\n    }\n});\n`,
          expected: ["return-void", "return-labeled"],
        },
        {
          name: "a return inside the try block of a try … finally",
          source: `${SEEN_NUMBERS}${MOVER_EACH}    try {\n        if (e.Position.x > 1) return;\n    } finally {\n        seen.push(e.Position.x);\n    }\n});\n`,
          expected: ["return-void", "return-in-finally"],
          absent: ["return-labeled"],
        },
        {
          name: "a return inside a finally block",
          source: `${SEEN_NUMBERS}${MOVER_EACH}    try {\n        seen.push(e.Position.x);\n    } finally {\n        if (e.Position.x > 1) return;\n    }\n});\n`,
          expected: ["return-in-finally"],
        },
        {
          name: "a return inside a try … catch without finally",
          source: `${SEEN_NUMBERS}${MOVER_EACH}    try {\n        if (e.Position.x > 1) return;\n    } catch {\n        seen.push(e.Position.x);\n    }\n});\n`,
          expected: ["return-void"],
          absent: ["return-in-finally"],
        },
        {
          name: "a return in a callback whose call sits inside a try … finally",
          source: `${SEEN_NUMBERS}try {\n    ${MOVER_EACH}        if (e.Position.x > 1) return;\n        seen.push(e.Position.x);\n    });\n} finally {\n    seen.push(0);\n}\n`,
          expected: ["return-void"],
          absent: ["return-in-finally"],
        },
        {
          name: "a return inside a function nested in a try … finally of the body",
          source: `${SEEN_NUMBERS}${MOVER_EACH}    const x = e.Position.x;\n    try {\n        seen.push((function () {\n            return x;\n        })());\n    } finally {\n        seen.push(0);\n    }\n});\n`,
          expected: ["return-in-nested-function"],
          absent: ["return-void", "return-value", "return-in-finally"],
        },
        {
          name: "a body var",
          source: `${SEEN_NUMBERS}${MOVER_EACH}    var x = e.Position.x;\n    seen.push(x);\n});\n`,
          expected: ["var-to-let"],
        },
        {
          name: "a var only inside a function the body nests",
          source: `${SEEN_NUMBERS}${MOVER_EACH}    const x = e.Position.x;\n    seen.push((() => {\n        var y = x;\n        return y;\n    })());\n});\n`,
          absent: ["var-to-let"],
        },
        {
          name: "a body label that a statement enclosing the call also declares",
          source: `${SEEN_NUMBERS}outer: for (let pass = 0; pass < 2; pass++) {\n    ${MOVER_EACH}        outer: for (;;) break outer;\n        seen.push(e.Position.x);\n    });\n    if (pass === 0) continue outer;\n}\n`,
          expected: ["user-label", "user-label-renamed"],
        },
        {
          name: "a body label that only a statement outside the call's function declares",
          source: `${SEEN_NUMBERS}outer: {\n    const run = (): void => {\n        ${MOVER_EACH}            outer: for (;;) break outer;\n            seen.push(e.Position.x);\n        });\n    };\n    run();\n    break outer;\n}\n`,
          expected: ["user-label"],
          absent: ["user-label-renamed"],
        },
        {
          name: "a label that an enclosing statement declares, used only inside a function the body nests",
          source: `${SEEN_UNKNOWN}outer: for (let pass = 0; pass < 2; pass++) {\n    ${MOVER_EACH}        seen.push(() => {\n            outer: for (;;) break outer;\n        });\n    });\n    if (pass === 0) continue outer;\n}\n`,
          absent: ["user-label-renamed"],
        },
        ...["storage", "n", "i"].map((local) => ({
          name: `an outer binding named like the loop's own ${local}`,
          source: `const ${local} = 2;\n${SEEN_NUMBERS}${MOVER_EACH}    seen.push(e.Position.x * ${local});\n});\n`,
          expected: ["outer-binding"] satisfies Rule[],
        })),
        ...["storage", "n", "i"].map((local) => ({
          name: `a class extending an outer class named like the loop's own ${local}`,
          source: `class ${local} {}\n${SEEN_UNKNOWN}${MOVER_EACH}    seen.push(e.Position.x, class extends ${local} {});\n});\n`,
          expected: ["outer-binding"] satisfies Rule[],
        })),
        {
          name: "a class declaration extending an outer class named like the loop's own",
          source: `class storage {}\n${SEEN_UNKNOWN}${MOVER_EACH}    class Probe extends storage {}\n    seen.push(e.Position.x, Probe);\n});\n`,
          expected: ["outer-binding"],
        },
        {
          name: "a class extending a generic outer class named like the loop's own",
          source: `class i<T> {\n    held?: T;\n}\n${SEEN_UNKNOWN}${MOVER_EACH}    seen.push(e.Position.x, class extends i<number> {});\n});\n`,
          expected: ["outer-binding"],
        },
        {
          name: "a class extending a member of an outer object named like the loop's own",
          source: `const n = { Base: class {} };\n${SEEN_UNKNOWN}${MOVER_EACH}    seen.push(e.Position.x, class extends n.Base {});\n});\n`,
          expected: ["outer-binding"],
        },
        ...["storage", "n", "i"].map((local) => ({
          name: `a body label named like the loop's own ${local}`,
          source: `${SEEN_NUMBERS}${MOVER_EACH}    ${local}: for (let k = 0; k < 2; k++) {\n        if (k === 1) break ${local};\n        if (k === 0) continue ${local};\n    }\n    seen.push(e.Position.x);\n});\n`,
          expected: ["user-label"] satisfies Rule[],
          absent: ["outer-binding"] satisfies Rule[],
        })),
        {
          name: "a class implementing an outer interface named like the loop's own",
          source: `interface i {\n    readonly x: number;\n}\n${SEEN_UNKNOWN}${MOVER_EACH}    seen.push(e.Position.x, class implements i {\n        readonly x = 1;\n    });\n});\n`,
          absent: ["outer-binding"],
        },
        {
          name: "a type annotation naming an outer type named like the loop's own",
          source: `type n = number;\n${SEEN_UNKNOWN}${MOVER_EACH}    const x: n = e.Position.x;\n    seen.push(x);\n});\n`,
          absent: ["outer-binding"],
        },
        {
          name: "a body binding named like the loop's own",
          source: `${SEEN_NUMBERS}${MOVER_EACH}    const i = 3;\n    seen.push(e.Position.x + i);\n});\n`,
          absent: ["outer-binding"],
        },
        {
          name: "an outer binding named unlike the loop's own",
          source: `const k = 3;\n${SEEN_NUMBERS}${MOVER_EACH}    seen.push(e.Position.x + k);\n});\n`,
          absent: ["outer-binding"],
        },
        {
          name: "a read of an outer let declared after the call",
          source: deadZoneSource("seen.push(e.Position.x, later);", "let later = 1;"),
          expected: ["outer-let-dead-zone"],
        },
        {
          name: "a read of an outer let declared before the call",
          source: `let earlier = 1;\nearlier += 1;\n${deadZoneSource("seen.push(e.Position.x, earlier);", "")}`,
          absent: ["outer-let-dead-zone"],
        },
        {
          name: "a read of an outer let declared after the call, inside a nested function",
          source: deadZoneSource("seen.push(e.Position.x, () => later);", "let later = 1;"),
          absent: ["outer-let-dead-zone"],
        },
        {
          name: "a read of an outer var declared after the call",
          source: deadZoneSource("seen.push(e.Position.x, later);", "var later = 1;"),
          absent: ["outer-let-dead-zone"],
        },
        {
          name: "a read of an outer class declared after the call",
          source: deadZoneSource("seen.push(e.Position.x, later);", "class later {}"),
          expected: ["outer-let-dead-zone"],
        },
        ...["let later = class {};", "const later = class {};", "class later {}"].map(
          (declaration) => ({
            name: `a class extending an outer ${declaration.split(" ")[0]} declared after the call`,
            source: deadZoneSource("seen.push(e.Position.x, class extends later {});", declaration),
            expected: ["outer-let-dead-zone"] satisfies Rule[],
          }),
        ),
        {
          name: "a class extending an outer class declared after the call, inside a nested function",
          source: deadZoneSource(
            "seen.push(e.Position.x, () => class extends later {});",
            "class later {}",
          ),
          absent: ["outer-let-dead-zone"],
        },
        {
          name: "a class implementing an outer class declared after the call",
          source: deadZoneSource(
            "seen.push(e.Position.x, class implements later {\n                readonly x = 1;\n            });",
            "class later {\n        readonly x = 1;\n    }",
          ),
          absent: ["outer-let-dead-zone"],
        },
        {
          name: "a type annotation naming an outer class declared after the call",
          source: deadZoneSource(
            "const held: later | number = e.Position.x;\n            seen.push(held);",
            "class later {}",
          ),
          absent: ["outer-let-dead-zone"],
        },
        {
          name: "a read of an outer object-pattern const declared after the call",
          source: deadZoneSource(
            "seen.push(e.Position.x, later);",
            "const { later } = { later: 1 };",
          ),
          expected: ["outer-let-dead-zone"],
        },
        {
          name: "a read of an outer nested array-pattern let declared after the call",
          source: deadZoneSource("seen.push(e.Position.x, later);", "let [, [later]] = [0, [1]];"),
          expected: ["outer-let-dead-zone"],
        },
        {
          name: "a read of an outer function declared after the call, which shadows a later file-level let",
          source: `${deadZoneSource("seen.push(e.Position.x, later);", "function later() {}")}let later = 1;\n`,
          absent: ["outer-let-dead-zone"],
        },
        {
          name: "a read of an outer pattern var declared after the call, which shadows a later file-level let",
          source: `${deadZoneSource("seen.push(e.Position.x, later);", "var { later } = { later: 1 };")}let later = 1;\n`,
          absent: ["outer-let-dead-zone"],
        },
      ],
    )(
      "names the rules the body applies for $name",
      async ({ source, expected = [], absent = [] }) => {
        const { applied } = await project.rewrite(CASE_PRELUDE + source);

        expect(applied).toStrictEqual(expect.arrayContaining([...expected]));
        expect(applied.filter((rule) => absent.includes(rule))).toStrictEqual([]);
      },
    );

    it.each<{
      name: string;
      failing: readonly number[];
      expected: readonly Rule[];
      absent: readonly Rule[];
    }>([
      {
        name: "neither loop throws",
        failing: [],
        expected: [...FIRST_LOOP_RULES, ...SECOND_LOOP_RULES],
        absent: [],
      },
      {
        name: "inlining the first loop throws",
        failing: [0],
        expected: SECOND_LOOP_RULES,
        absent: FIRST_LOOP_RULES,
      },
      {
        name: "inlining the second loop throws",
        failing: [1],
        expected: FIRST_LOOP_RULES,
        absent: SECOND_LOOP_RULES,
      },
    ])(
      "names the rules of every loop the file kept when $name",
      async ({ failing, expected, absent }) => {
        const planned = await project.planned(CASE_PRELUDE + TWO_LOOPS_SOURCE);
        const failingCalls = new Set(failing.map((index) => rewriteAt(planned, index).call));
        const thrown: unknown[] = [];

        const { applied } = await project.emit(planned, {
          beforeCommit: (inlining) => {
            if (failingCalls.has(inlining.call)) throw new Error("banana split");
          },
          inline: (file, inlining, uses) => {
            try {
              file.inline(inlining, uses);
            } catch (error) {
              thrown.push(error instanceof Error ? error.message : error);
            }
          },
        });

        expect(thrown).toStrictEqual(failing.map(() => "banana split"));
        expect(applied).toStrictEqual(expect.arrayContaining([...expected]));
        expect(applied.filter((rule) => absent.includes(rule))).toStrictEqual([]);
      },
    );
  });
});
