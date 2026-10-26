import { type Expression, getTouchingPropertyName } from "typescript/ast";
import { isCallExpression } from "typescript/ast/is";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PackageRoots } from "../../../../src/plugin/optimizer/analysis/roots.js";
import { resolveShapes } from "../../../../src/plugin/optimizer/analysis/shape.js";
import type {
  ArchShape,
  Component,
  Field,
  Reason,
} from "../../../../src/plugin/optimizer/facts.js";
import type { ProjectView, Session } from "../../../../src/plugin/optimizer/session.js";
import {
  caseFile,
  caseFiles,
  closeProject,
  openProject,
  projectPath,
  RUNTIME_TSCONFIG,
  runtimeProject,
  SHARED_ARCHETYPE_FILES,
  SPAWN_TIMEOUT_MS,
} from "../project.js";

const STORAGES_SOURCE = `import { createWorld, register, type Storage } from "../src/ecstatic/index.js";
import { Enemy } from "./archetypes.js";

export const enemies = register(createWorld(), Enemy);

export function enemiesOf(): Storage<typeof Enemy> {
  return enemies;
}
`;

/** Storages typed by annotations naming an archetype declared in another file. */
const FLEET_SOURCE = `import { createWorld, register, type Storage } from "../src/ecstatic/index.js";
import { Enemy } from "./archetypes.js";

export const fleet: Storage<typeof Enemy>[] = [register(createWorld(), Enemy)];
export const flagship: Storage<typeof Enemy> = register(createWorld(), Enemy);
`;

/** A factory whose return type is inferred from its body. */
const FACTORY_SOURCE = `import { createWorld, register } from "../src/ecstatic/index.js";
import { Enemy } from "./archetypes.js";

export function makeEnemies() {
  return register(createWorld(), Enemy);
}
`;

/** A storage whose type is inferred from a call to the factory another file declares. */
const INFERRED_SOURCE = `import { makeEnemies } from "./factory.js";

export const madeEnemies = makeEnemies();
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
    name: "a call to a function declared in another module",
    want: [ENEMY],
    consulted: ["app/storages.ts"],
    source: `import { enemiesOf } from "../storages.js";
each(enemiesOf(), () => {});
`,
  },
  {
    name: "a storage whose inferred type comes from a third module",
    want: [ENEMY],
    consulted: ["app/inferred.ts", "app/factory.ts"],
    source: `import { madeEnemies } from "../inferred.js";
each(madeEnemies, () => {});
`,
  },
  {
    name: "a for-of variable over storages imported from another module",
    want: [ENEMY],
    consulted: ["app/fleet.ts", "app/archetypes.ts"],
    source: `import { fleet } from "../fleet.js";
for (const s of fleet) each(s, () => {});
`,
  },
  {
    name: "an unannotated callback parameter typed by its call",
    want: [ENEMY],
    consulted: ["app/fleet.ts"],
    source: `import { fleet } from "../fleet.js";
fleet.forEach((s) => {
	each(s, () => {});
});
`,
  },
  {
    name: "a class field initialized from another module",
    want: [ENEMY],
    consulted: ["app/fleet.ts"],
    source: `import { flagship } from "../fleet.js";
export class Game {
	readonly ships = flagship;
	run(): void {
		each(this.ships, () => {});
	}
}
`,
  },
  {
    name: "a getter returning a storage from another module",
    want: [ENEMY],
    consulted: ["app/fleet.ts"],
    source: `import { flagship } from "../fleet.js";
export class Game {
	get ships() {
		return flagship;
	}
	run(): void {
		each(this.ships, () => {});
	}
}
`,
  },
  {
    name: "a method returning a storage from another module",
    want: [ENEMY],
    consulted: ["app/fleet.ts"],
    source: `import { flagship } from "../fleet.js";
export class Game {
	ships() {
		return flagship;
	}
	run(): void {
		each(this.ships(), () => {});
	}
}
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

const ROOTS = new PackageRoots();

let root = "";
let session: Session;
let view: ProjectView;

beforeAll(async () => {
  ({ root, session, view } = await openProject(
    runtimeProject({
      ...SHARED_ARCHETYPE_FILES,
      "app/storages.ts": STORAGES_SOURCE,
      "app/fleet.ts": FLEET_SOURCE,
      "app/factory.ts": FACTORY_SOURCE,
      "app/inferred.ts": INFERRED_SOURCE,
      ...caseFiles(CASE_STEM, SOURCES, CASE_PRELUDE),
    }),
  ));
}, SPAWN_TIMEOUT_MS);

afterAll(() => closeProject(session));

/** The absolute path of the project file at the slash-separated `rel`. */
function projectFile(rel: string): string {
  return projectPath(root, rel);
}

/** The storages argument of the first `each` call in the file at `path` as `projectView` sees it. */
async function eachStorages(projectView: ProjectView, path: string): Promise<Expression> {
  const file = await projectView.sourceFile(path);
  const call = getTouchingPropertyName(file, file.text.indexOf("each(")).parent;
  const storages = isCallExpression(call) ? call.arguments[0] : undefined;
  if (storages === undefined) throw new Error(`${path} holds no each call`);
  return storages;
}

/** The storages argument of the `each` call in the case file holding `source`. */
function storagesIn(source: string): Promise<Expression> {
  return eachStorages(view, projectFile(caseFile(CASE_STEM, SOURCES.indexOf(source))));
}

describe("resolveShapes", () => {
  it.each(RESOLVED_CASES)("resolves $name", async ({ source, want, consulted = [] }) => {
    const storages = await storagesIn(source);

    const resolved = await resolveShapes(view.checker, storages, ROOTS);

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

    const resolved = await resolveShapes(view.checker, storages, ROOTS);

    expect({ shapes: resolved.shapes, reason: resolved.reason }).toStrictEqual({
      shapes: [],
      reason,
    });
  });

  it.each(DECLARATION_FILE_CASES)(
    "lists the declaration files consulted for $name",
    async ({ source }) => {
      const storages = await storagesIn(source);

      const resolved = await resolveShapes(view.checker, storages, ROOTS);

      expect(new Set(resolved.declarationFiles)).toStrictEqual(
        new Set(SHIP_DECLARATION_FILES.map(projectFile)),
      );
    },
  );
});

/** A case file whose `each` call walks a component mixing ref fields with plain-valued ones. */
const REF_FIELDS_SOURCE = `import { archetype, component, each, ref, type Storage } from "../src/ecstatic/index.js";

const Mixed = component("Mixed", {
  count: 0,
  on: true,
  label: "",
  id: ref<number>(),
  flag: ref<boolean>(),
  name: ref<string>(),
});
const Mixes = archetype([Mixed]);
declare const s: Storage<typeof Mixes>;
each(s, () => {});
`;

/**
 * A declaration file declaring the component of {@link REF_FIELDS_SOURCE} as declaration emit
 * writes it: each ref field's marker is gone, leaving its value type joined with `undefined`.
 */
const REF_FIELDS_DECLARATION = `import type { Component } from "../src/ecstatic/index.js";

export declare const Mixed: Component<"Mixed", {
  count: number;
  on: boolean;
  label: string;
  id: number | undefined;
  flag: boolean | undefined;
  name: string | undefined;
}>;
`;

/** A case file whose \`each\` call walks the component {@link REF_FIELDS_DECLARATION} declares. */
const DECLARED_REF_FIELDS_SOURCE = `import { archetype, each, type Storage } from "../src/ecstatic/index.js";
import { Mixed } from "./declared.js";

const Mixes = archetype([Mixed]);
declare const s: Storage<typeof Mixes>;
each(s, () => {});
`;

/** A case file whose \`each\` call walks a component built from defaults typed by an annotation. */
const ANNOTATED_REF_FIELDS_SOURCE = `import {
  archetype,
  component,
  each,
  ref,
  type RefMarker,
  type Storage,
} from "../src/ecstatic/index.js";

const defaults: {
  count: number;
  on: boolean;
  label: string;
  id: RefMarker<number>;
  flag: RefMarker<boolean>;
  name: RefMarker<string>;
} = { count: 0, on: true, label: "", id: ref(), flag: ref(), name: ref() };
const Mixed = component("Mixed", defaults);
const Mixes = archetype([Mixed]);
declare const s: Storage<typeof Mixes>;
each(s, () => {});
`;

const REF_FIELDS_SHAPE: ArchShape = {
  required: [
    {
      name: "Mixed",
      fields: [
        numberField("count"),
        booleanField("on"),
        plainField("label"),
        plainField("id"),
        plainField("flag"),
        plainField("name"),
      ],
      relation: false,
    },
  ],
  optional: [],
};

/** The runtime tsconfig with `strictNullChecks` set, and the options that require it following it. */
function runtimeTsconfig(strictNullChecks: boolean): string {
  const config: { compilerOptions: Record<string, unknown> } = JSON.parse(RUNTIME_TSCONFIG);
  return JSON.stringify({
    ...config,
    compilerOptions: {
      ...config.compilerOptions,
      strictNullChecks,
      exactOptionalPropertyTypes: strictNullChecks,
    },
  });
}

describe.each([{ strictNullChecks: true }, { strictNullChecks: false }])(
  "resolveShapes with strictNullChecks $strictNullChecks",
  ({ strictNullChecks }) => {
    let refRoot = "";
    let refSession: Session;
    let refView: ProjectView;

    beforeAll(async () => {
      ({
        root: refRoot,
        session: refSession,
        view: refView,
      } = await openProject(
        runtimeProject({
          "tsconfig.json": runtimeTsconfig(strictNullChecks),
          "app/refs.ts": REF_FIELDS_SOURCE,
          "app/declared.d.ts": REF_FIELDS_DECLARATION,
          "app/declared-refs.ts": DECLARED_REF_FIELDS_SOURCE,
          "app/annotated-refs.ts": ANNOTATED_REF_FIELDS_SOURCE,
        }),
      ));
    }, SPAWN_TIMEOUT_MS);

    afterAll(() => refSession.close());

    it.each([
      { origin: "a ref marker", file: "app/refs.ts" },
      { origin: "a declaration file's undefined-joined type", file: "app/declared-refs.ts" },
      { origin: "an annotated defaults object", file: "app/annotated-refs.ts" },
    ])("resolves ref fields declared through $origin as plain columns", async ({ file }) => {
      const storages = await eachStorages(refView, projectPath(refRoot, file));

      const resolved = await resolveShapes(refView.checker, storages, ROOTS);

      expect({ shapes: resolved.shapes, reason: resolved.reason }).toStrictEqual({
        shapes: [REF_FIELDS_SHAPE],
        reason: undefined,
      });
    });
  },
);
