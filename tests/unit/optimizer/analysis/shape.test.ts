import { type Expression, getTouchingPropertyName } from "typescript/ast";
import { isCallExpression } from "typescript/ast/is";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { resolveShapes } from "../../../../src/plugin/optimizer/analysis/shape.js";
import type {
  ArchShape,
  Component,
  Field,
  Reason,
} from "../../../../src/plugin/optimizer/facts.js";
import type { ProjectView, Session } from "../../../../src/plugin/optimizer/session.js";
import {
  caseFiles,
  closeProject,
  openProject,
  projectPath,
  runtimeProject,
  SHARED_ARCHETYPE_FILES,
  SPAWN_TIMEOUT_MS,
} from "../project.js";

const STORAGES_SOURCE = `import { createWorld, register } from "../src/ecstatic/index.js";
import { Enemy } from "./archetypes.js";

export const enemies = register(createWorld(), Enemy);
`;

/** Opens every case file: the runtime API and the shared archetypes and components. */
const CASE_PRELUDE = `import { archetype, component, createWorld, each, getStorage, register, type Storage, type World } from "../../src/ecstatic/index.js";
import type { ArchetypeDescriptor, ComponentDescriptor } from "../../src/ecstatic/archetype.js";
import { Enemy, Hull, Linked, Ship } from "../archetypes.js";
import { Position } from "../position.js";
import { Velocity } from "../components.js";
`;

interface ShapeCase {
  readonly name: string;
  readonly source: string;
}

interface ResolvedCase extends ShapeCase {
  readonly want: readonly ArchShape[];
  /** Project-relative files the resolution must list among its declaration files. */
  readonly consulted?: readonly string[];
}

interface UnresolvedCase extends ShapeCase {
  readonly reason: Reason;
}

/** A case source that declares `s` with `storageType` and calls `each` over it. */
function eachOver(storageType: string): string {
  return `declare const s: ${storageType};\neach(s, () => {});\n`;
}

/** A field named `name` of the number kind. */
function numberField(name: string): Field {
  return { name, kind: "number" };
}

/** A field named `name` of the boolean kind. */
function booleanField(name: string): Field {
  return { name, kind: "boolean" };
}

/** A field named `name` of the plain kind. */
function plainField(name: string): Field {
  return { name, kind: "plain" };
}

/** A non-relation component with no fields. */
function tag(name: string): Component {
  return { name, fields: [], relation: false };
}

const POSITION: Component = {
  name: "Position",
  fields: [numberField("x"), numberField("y")],
  relation: false,
};

const VELOCITY: Component = {
  name: "Velocity",
  fields: [numberField("dx"), numberField("dy")],
  relation: false,
};

const SHIELD: Component = {
  name: "Shield",
  fields: [numberField("hp"), booleanField("active"), plainField("label"), plainField("owner")],
  relation: false,
};

const ENEMY: ArchShape = { required: [POSITION, VELOCITY], optional: [SHIELD, tag("Stunned")] };

const SHIP: ArchShape = {
  required: [POSITION],
  optional: [SHIELD, tag("Stunned"), tag("Boost")],
};

const LINKED: ArchShape = {
  required: [
    POSITION,
    {
      name: "ChildOf",
      fields: [numberField("order"), booleanField("pinned")],
      relation: true,
    },
  ],
  optional: [],
};

const RESOLVED_CASES: readonly ResolvedCase[] = [
  {
    name: "a local register result",
    want: [ENEMY],
    source: `const world = createWorld();
const enemies = register(world, Enemy);
each(enemies, () => {});
`,
  },
  {
    name: "a class archetype",
    want: [SHIP],
    source: `const ships = register(createWorld(), Ship);
each(ships, () => {});
`,
  },
  {
    name: "a parameter typed Storage<typeof X>",
    want: [ENEMY],
    source: `export function move(s: Storage<typeof Enemy>): void {
	each(s, () => {});
}
`,
  },
  {
    name: "a parameter typed Storage<X>",
    want: [SHIP],
    source: `export function move(s: Storage<Ship>): void {
	each(s, () => {});
}
`,
  },
  {
    name: "a storage imported from another module",
    want: [ENEMY],
    consulted: ["app/storages.ts"],
    source: `import { enemies } from "../storages.js";
each(enemies, () => {});
`,
  },
  {
    name: "a class field",
    want: [SHIP],
    source: `export class Game {
	readonly ships = register(createWorld(), Ship);
	run(): void {
		each(this.ships, () => {});
	}
}
`,
  },
  {
    name: "a property chain",
    want: [ENEMY],
    source: `const game = { pools: { enemies: register(createWorld(), Enemy) } };
each(game.pools.enemies, () => {});
`,
  },
  {
    name: "a call result",
    want: [ENEMY],
    source: `function enemiesOf(world: World): Storage<typeof Enemy> {
	return register(world, Enemy);
}
each(enemiesOf(createWorld()), () => {});
`,
  },
  {
    name: "getStorage",
    want: [SHIP],
    source: "each(getStorage(createWorld(), Ship), () => {});\n",
  },
  {
    name: "a generic constrained to a storage type",
    want: [ENEMY],
    source: `export function move<S extends Storage<typeof Enemy>>(s: S): void {
	each(s, () => {});
}
`,
  },
  {
    name: "an as cast",
    want: [ENEMY],
    source: `declare const raw: Storage;
each(raw as Storage<typeof Enemy>, () => {});
`,
  },
  {
    name: "a union of storages sharing one shape",
    want: [SHIP],
    source: eachOver("Storage<Ship> | Storage<Hull>"),
  },
  {
    name: "relation fields from its relation meta",
    want: [LINKED],
    source: eachOver("Storage<typeof Linked>"),
  },
  {
    name: "a unique-symbol field key left out of the fields",
    want: [
      { required: [{ name: "Walker", fields: [numberField("x")], relation: false }], optional: [] },
    ],
    source: `const Walker = component("Walker", { x: 0, [Symbol.iterator]: 0 });
const Walkers = archetype([Walker]);
declare const s: Storage<typeof Walkers>;
each(s, () => {});
`,
  },
  {
    name: "an array literal, one shape per element in order",
    want: [ENEMY, SHIP],
    source: `const world = createWorld();
each([register(world, Enemy), register(world, Ship)], () => {});
`,
  },
  {
    name: "a comma inside a component name staying one component",
    want: [
      { required: [tag("A,B")], optional: [] },
      { required: [tag("A"), tag("B")], optional: [] },
    ],
    source: `const Joined = archetype([component("A,B")]);
const Split = archetype([component("A"), component("B")]);
const world = createWorld();
each([register(world, Joined), register(world, Split)], () => {});
`,
  },
];

const UNRESOLVED_STORAGE_CASES: readonly ShapeCase[] = [
  { name: "a wide Storage", source: eachOver("Storage") },
  {
    name: "a union of storages with different shapes",
    source: eachOver("Storage<typeof Enemy> | Storage<Ship>"),
  },
  { name: "any", source: eachOver("any") },
  {
    name: "unknown",
    source: `declare const s: unknown;
// @ts-expect-error -- unknown is not a storage
each(s, () => {});
`,
  },
  {
    name: "an unconstrained type parameter",
    source: `export function move<S>(s: S): void {
	// @ts-expect-error -- S is not a storage
	each(s, () => {});
}
`,
  },
  {
    name: "a conditional component tuple",
    source: `type Choose<T> = T extends string ? readonly [typeof Position] : readonly [typeof Velocity];
export function move<T>(s: Storage<ArchetypeDescriptor<Choose<T>>>): void {
	each(s, () => {});
}
`,
  },
  {
    name: "a mapped component tuple",
    source: `type Positions<T extends readonly unknown[]> = { readonly [K in keyof T]: typeof Position };
export function move<T extends readonly unknown[]>(s: Storage<ArchetypeDescriptor<Positions<T>>>): void {
	each(s, () => {});
}
`,
  },
];

const UNPINNED_TUPLE_CASES: readonly ShapeCase[] = [
  {
    name: "a union with an unresolved member",
    source: eachOver("Storage<typeof Enemy> | Storage"),
  },
  { name: "a storage of an any archetype", source: eachOver("Storage<any>") },
  {
    name: "a component meta without fields",
    source: `declare const Bare: ComponentDescriptor & { readonly __ecstatic_name: "Bare"; readonly __ecstatic_component_meta?: { name: "Bare" } };
const Bares = archetype([Bare]);
declare const s: Storage<typeof Bares>;
each(s, () => {});
`,
  },
  {
    name: "a rest element",
    source: `declare const extras: (typeof Velocity)[];
const Mixed = archetype([Position, ...extras]);
declare const s: Storage<typeof Mixed>;
each(s, () => {});
`,
  },
  {
    name: "a rest element among optionals",
    source: `declare const extras: (typeof Velocity)[];
const Mixed = archetype([Position], [Velocity, ...extras]);
declare const s: Storage<typeof Mixed>;
each(s, () => {});
`,
  },
  {
    name: "an optional element",
    source: `// @ts-expect-error -- a tuple with an optional element is not a component list
declare const s: Storage<ArchetypeDescriptor<readonly [typeof Position, (typeof Velocity)?]>>;
// @ts-expect-error -- no each overload accepts a storage of that invalid descriptor
each(s, () => {});
`,
  },
  {
    name: "a variadic element whose constraint carries a literal name",
    source: `export function move<T extends readonly (typeof Velocity)[] & typeof Velocity>(s: Storage<ArchetypeDescriptor<readonly [typeof Position, ...T], readonly []>>): void {
	each(s, () => {});
}
`,
  },
  {
    name: "a union-typed element",
    source: `declare const pick: typeof Position | typeof Velocity;
const Picked = archetype([pick]);
declare const s: Storage<typeof Picked>;
each(s, () => {});
`,
  },
  {
    name: "a component name typed string",
    source: `declare const name: string;
const Named = component(name, { x: 0 });
const Wide = archetype([Named]);
declare const s: Storage<typeof Wide>;
each(s, () => {});
`,
  },
  {
    name: "an optional component name typed as a union of literals",
    source: `declare const flag: boolean;
const Either = component(flag ? "Left" : "Right");
const Picked = archetype([Position], [Either]);
declare const s: Storage<typeof Picked>;
each(s, () => {});
`,
  },
];

const DYNAMIC_STORAGES_CASES: readonly ShapeCase[] = [
  {
    name: "a storages argument that is not an array literal",
    source: `const list = [register(createWorld(), Enemy)];
each(list, () => {});
`,
  },
  {
    name: "an array literal with an unresolved element",
    source: `declare const wide: Storage;
each([register(createWorld(), Enemy), wide], () => {});
`,
  },
  {
    name: "an array literal with a spread element",
    source: `const list = [register(createWorld(), Enemy)];
each([...list], () => {});
`,
  },
];

const UNRESOLVED_CASES: readonly UnresolvedCase[] = [
  ...[...UNRESOLVED_STORAGE_CASES, ...UNPINNED_TUPLE_CASES].map(
    ({ name, source }): UnresolvedCase => ({ name, source, reason: "SHAPE_UNRESOLVED" }),
  ),
  ...DYNAMIC_STORAGES_CASES.map(({ name, source }): UnresolvedCase => ({
    name,
    source,
    reason: "STORAGES_DYNAMIC",
  })),
];

/** The files every `Storage<Ship>` resolution consults, relative to the project root. */
const SHIP_DECLARATION_FILES = [
  "app/archetypes.ts",
  "app/components.ts",
  "app/position.ts",
  "src/ecstatic/archetype.ts",
  "src/ecstatic/component.ts",
  "src/ecstatic/world.ts",
];

const DECLARATION_FILE_CASES: readonly ShapeCase[] = [
  { name: "a single storage", source: eachOver("Storage<Ship>") },
  { name: "a union of storages", source: eachOver("Storage<Ship> | Storage<Hull>") },
];

const SOURCES = [...RESOLVED_CASES, ...UNRESOLVED_CASES, ...DECLARATION_FILE_CASES].map(
  ({ source }) => source,
);

const CASE_STEM = "app/case/case";

let root = "";
let session: Session;
let view: ProjectView;

beforeAll(async () => {
  ({ root, session, view } = await openProject(
    runtimeProject({
      ...SHARED_ARCHETYPE_FILES,
      "app/storages.ts": STORAGES_SOURCE,
      ...caseFiles(CASE_STEM, SOURCES, CASE_PRELUDE),
    }),
  ));
}, SPAWN_TIMEOUT_MS);

afterAll(() => closeProject(session));

/** The absolute path of the project file at the slash-separated `rel`. */
function projectFile(rel: string): string {
  return projectPath(root, rel);
}

/** The storages argument of the `each` call in the case file holding `source`. */
async function storagesIn(source: string): Promise<Expression> {
  const file = await view.sourceFile(projectFile(`${CASE_STEM}${SOURCES.indexOf(source)}.ts`));
  const call = getTouchingPropertyName(file, file.text.indexOf("each(")).parent;
  const storages = isCallExpression(call) ? call.arguments[0] : undefined;
  if (storages === undefined) throw new Error(`${source} holds no each call`);
  return storages;
}

describe("resolveShapes", () => {
  it.each(RESOLVED_CASES)("resolves $name", async ({ source, want, consulted = [] }) => {
    const storages = await storagesIn(source);

    const resolved = await resolveShapes(view.checker, storages);

    expect({ shapes: resolved.shapes, reason: resolved.reason }).toStrictEqual({
      shapes: want,
      reason: undefined,
    });
    expect(resolved.declarationFiles).toStrictEqual(
      expect.arrayContaining(consulted.map(projectFile)),
    );
  });

  it.each(UNRESOLVED_CASES)("records $reason for $name", async ({ source, reason }) => {
    const storages = await storagesIn(source);

    const resolved = await resolveShapes(view.checker, storages);

    expect({ shapes: resolved.shapes, reason: resolved.reason }).toStrictEqual({
      shapes: [],
      reason,
    });
  });

  it.each(DECLARATION_FILE_CASES)(
    "lists the declaration files consulted for $name",
    async ({ source }) => {
      const storages = await storagesIn(source);

      const resolved = await resolveShapes(view.checker, storages);

      expect(new Set(resolved.declarationFiles)).toStrictEqual(
        new Set(SHIP_DECLARATION_FILES.map(projectFile)),
      );
    },
  );
});
