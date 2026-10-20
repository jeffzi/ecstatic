import { describe, expect, it } from "vitest";

import {
  archetype,
  component,
  createWorld,
  register,
  relation,
} from "../../../src/ecstatic/index.js";
import { assertShape } from "../../../src/ecstatic/shape-guard.js";
import {
  addDeclarationFile,
  type ArchShape,
  type Component,
  componentField,
  type Field,
  opByName,
  reasonInfo,
  REASONS,
  type ReasonInfo,
  shapeComponent,
  shapeKey,
  type Site,
} from "../../../src/plugin/optimizer/facts.js";

/** A call site of `each` with nothing recorded on it. */
function emptySite(): Site {
  return {
    callback: undefined,
    reasons: [],
    nested: [],
    shapes: [],
    declarationFiles: [],
    root: "",
    pos: { file: "main.ts", offset: 0, line: 1, column: 1 },
    call: 0,
    op: "each",
    context: "expression-statement",
    filtered: false,
    arrayLiteral: false,
  };
}

/** A non-relation component with no fields. */
function tag(name: string): Component {
  return { name, fields: [], relation: false };
}

/** A field named `name` of the number kind. */
function numberField(name: string): Field {
  return { name, kind: "number" };
}

/** A component named `name` holding number fields named `fields`. */
function numbers(name: string, ...fields: string[]): Component {
  return { name, fields: fields.map(numberField), relation: false };
}

/** A shape whose required components are `comps` and that has no optionals. */
function requiredOnly(...comps: Component[]): ArchShape {
  return { required: comps, optional: [] };
}

describe("opByName", () => {
  it.each([
    "each",
    "query",
    "querySources",
    "has",
    "hasAny",
    "enable",
    "disable",
    "get",
    "set",
    "alive",
    "enableMany",
    "disableMany",
    "spawn",
    "spawnMany",
    "despawn",
    "despawnMany",
    "getTarget",
    "link",
    "unlink",
    "getResource",
    "setResource",
    "resetResource",
    "getSources",
    "hasSources",
    "countSources",
    "register",
    "createWorld",
    "destroyWorld",
    "getStorage",
    "archetype",
    "Archetype",
    "component",
    "components",
    "relation",
    "resource",
    "ref",
    "f32",
    "f64",
    "i8",
    "i16",
    "i32",
    "u8",
    "u16",
    "u32",
  ])("finds the op named %s", (name) => {
    const op = opByName(name);

    expect(op).toBe(name);
  });

  it.each([
    { name: "empty", input: "" },
    { name: "not an ecstatic function", input: "banana" },
    { name: "module export missing from index", input: "eachStorageMatched" },
    { name: "case differs from a declaration", input: "Each" },
  ])("reports $name as not found", ({ input }) => {
    const op = opByName(input);

    expect(op).toBeUndefined();
  });
});

/** The expected reason catalog, in declaration order. */
const REASON_ROWS: readonly ReasonInfo[] = [
  {
    id: "SHAPE_UNRESOLVED",
    code: 99_910,
    category: "strict",
    text: "the storage's archetype shape is not known statically",
    hint: "Type the storage as `Storage<typeof X>` or `Storage<X>`.",
  },
  {
    id: "STORAGES_DYNAMIC",
    code: 99_912,
    category: "strict",
    text: "the storages argument is not an array literal of typed storages",
  },
  {
    id: "CALLBACK_NOT_INLINE",
    code: 99_913,
    category: "strict",
    text: "the callback is not written inline",
    hint: "Write `(e) => { ... }` at the call site.",
  },
  {
    id: "CALLBACK_PARAMS",
    code: 99_914,
    category: "strict",
    text:
      "the callback has a defaulted, rest, or array-pattern parameter, more than one parameter, " +
      "or a `var` redeclaring a destructured parameter",
    hint: "Use `(e)` or an object pattern.",
  },
  {
    id: "CALLBACK_ASYNC",
    code: 99_915,
    category: "warning",
    text: "the callback is async",
    hint: "Views are valid only until the callback returns; collect ids and await between passes.",
  },
  {
    id: "CALLBACK_GENERATOR",
    code: 99_916,
    category: "strict",
    text: "the callback is a generator function",
  },
  {
    id: "CALLBACK_FUNCTION_BINDINGS",
    code: 99_917,
    category: "strict",
    text: "the callback uses `this`, `arguments`, `new.target`, or its own name",
    hint: "Use an arrow function.",
  },
  {
    id: "VIEW_ESCAPES",
    code: 99_918,
    category: "strict",
    text: "the view `e` is used as a value (`<detail>`)",
    hint: "Read fields on `e`, or keep `e.id`.",
  },
  {
    id: "UNSUPPORTED_ASSIGNMENT",
    code: 99_919,
    category: "strict",
    text: "a field is the target of a destructuring assignment or a `for…of` head",
  },
  {
    id: "INTERNAL",
    code: 99_920,
    category: "strict",
    text: "internal error (`<detail>`); please report it",
  },
  {
    id: "ARG_COUNT",
    category: "silent",
    text: "argument count matches no rewritable overload",
  },
  {
    id: "NOT_STATEMENT",
    category: "silent",
    text: "the call's value is used",
  },
  {
    id: "OP_NOT_REWRITTEN",
    category: "silent",
    text: "the call form has no rewrite in this version",
  },
];

describe("reason catalog", () => {
  it("lists every reason in declaration order", () => {
    const ids = REASONS.map((reason) => reasonInfo(reason).id);

    expect(ids).toStrictEqual(REASON_ROWS.map((row) => row.id));
  });

  it.each(REASON_ROWS)("describes $id", (row) => {
    const info = reasonInfo(row.id);

    expect(info).toStrictEqual(row);
  });

  it("gives no two reasons the same code", () => {
    const codes = REASONS.flatMap((reason) => reasonInfo(reason).code ?? []);

    expect(new Set(codes).size).toBe(codes.length);
  });
});

/** `class Ship extends Archetype([Position], [Shield, Stunned, Boost])`. */
const SHIP_SHAPE: ArchShape = {
  required: [numbers("Position", "x", "y")],
  optional: [numbers("Shield", "hp"), tag("Stunned"), tag("Boost")],
};

describe("shapeKey", () => {
  const Position = component("Position", { x: 0, y: 0 });
  const Shield = component("Shield", { hp: 0 });
  const Stunned = component("Stunned");
  const Boost = component("Boost");
  const Body = component("Body", { z: false, a: "", m: 0 });
  const ChildOf = relation("ChildOf", { order: 0 });
  const CommaName = component("A,B");
  const A = component("A");
  const B = component("B");
  const Delta = component("Δ");
  const Rocket = component("Rocket\u{1F680}");

  const cases = [
    {
      name: "required then optional, each name length-prefixed",
      shape: SHIP_SHAPE,
      arch: archetype([Position], [Shield, Stunned, Boost]),
      key: "c8:Position{1:x=n,1:y=n}|c6:Shield{2:hp=n}c7:Stunned{}c5:Boost{}",
    },
    {
      name: "fields sorted by name with their column kinds",
      shape: requiredOnly({
        name: "Body",
        fields: [
          { name: "z", kind: "boolean" },
          { name: "a", kind: "plain" },
          { name: "m", kind: "number" },
        ],
        relation: false,
      }),
      arch: archetype([Body]),
      key: "c4:Body{1:a=p,1:m=n,1:z=b}|",
    },
    {
      name: "relation flag",
      shape: requiredOnly({ ...numbers("ChildOf", "order"), relation: true }),
      arch: archetype([ChildOf]),
      key: "r7:ChildOf{5:order=n}|",
    },
    {
      name: "comma inside a name stays one component",
      shape: requiredOnly(tag("A,B")),
      arch: archetype([CommaName]),
      key: "c3:A,B{}|",
    },
    {
      name: "two components",
      shape: requiredOnly(tag("A"), tag("B")),
      arch: archetype([A, B]),
      key: "c1:A{}c1:B{}|",
    },
    {
      name: "optional-only shape",
      shape: { required: [], optional: [tag("A")] },
      arch: archetype([], [A]),
      key: "|c1:A{}",
    },
    {
      name: "non-ASCII name length counts UTF-16 code units",
      shape: requiredOnly(tag("Δ")),
      arch: archetype([Delta]),
      key: "c1:Δ{}|",
    },
    {
      name: "astral-plane name length counts a surrogate pair as two",
      shape: requiredOnly(tag("Rocket\u{1F680}")),
      arch: archetype([Rocket]),
      key: "c8:Rocket\u{1F680}{}|",
    },
  ];

  it.each(cases)("writes the key for $name", ({ shape, key }) => {
    const got = shapeKey(shape);

    expect(got).toBe(key);
  });

  it("sorts field names by UTF-16 code unit, astral before high BMP", () => {
    const shape = requiredOnly(numbers("Glyph", "Ａ", "\u{1D400}"));

    const got = shapeKey(shape);

    expect(got).toBe("c5:Glyph{2:\u{1D400}=n,1:Ａ=n}|");
  });

  it.each(cases)("matches the runtime shape guard for $name", ({ shape, arch }) => {
    const storage = register(createWorld(), arch);

    const key = shapeKey(shape);

    expect(() => {
      assertShape(storage, key);
    }).not.toThrow();
  });

  it("leaves unsorted fields in declaration order", () => {
    const shape = requiredOnly(numbers("Body", "z", "a"));

    shapeKey(shape);

    expect(shape.required[0]?.fields).toStrictEqual([numberField("z"), numberField("a")]);
  });
});

describe("shapeComponent", () => {
  const pos = numbers("Pos", "x");
  const frozen = tag("Frozen");
  const shape: ArchShape = { required: [pos], optional: [frozen] };

  it.each([
    { name: "a required component", lookup: "Pos", want: pos },
    { name: "an optional component", lookup: "Frozen", want: frozen },
    { name: "an absent component", lookup: "Vel", want: undefined },
  ])("finds $name", ({ lookup, want }) => {
    const got = shapeComponent(shape, lookup);

    expect(got).toStrictEqual(want);
  });
});

describe("componentField", () => {
  const comp: Component = {
    name: "Pos",
    fields: [numberField("x"), { name: "on", kind: "boolean" }],
    relation: false,
  };

  it.each([
    { name: "a declared field", lookup: "on", want: { name: "on", kind: "boolean" } },
    { name: "an absent field", lookup: "y", want: undefined },
  ])("finds $name", ({ lookup, want }) => {
    const got = componentField(comp, lookup);

    expect(got).toStrictEqual(want);
  });
});

describe("addDeclarationFile", () => {
  it.each([
    {
      name: "keeps files added out of order sorted",
      files: ["/p/c.ts", "/p/a.ts", "/p/b.ts"],
      want: ["/p/a.ts", "/p/b.ts", "/p/c.ts"],
    },
    {
      name: "records a file added twice once",
      files: ["/p/b.ts", "/p/a.ts", "/p/b.ts"],
      want: ["/p/a.ts", "/p/b.ts"],
    },
  ])("$name", ({ files, want }) => {
    const site = emptySite();

    for (const file of files) {
      addDeclarationFile(site, file);
    }

    expect(site.declarationFiles).toStrictEqual(want);
  });
});
