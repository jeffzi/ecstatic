import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { analyze } from "../../../../src/plugin/optimizer/analysis/analyze.js";
import { PackageRoots } from "../../../../src/plugin/optimizer/analysis/roots.js";
import type {
  Filter,
  FilterForm,
  LiteralFilter,
  NodeID,
  Site,
} from "../../../../src/plugin/optimizer/facts.js";
import type { NodeTable } from "../../../../src/plugin/optimizer/nodes.js";
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

/** Opens every case file: the runtime API, the shared components, and a declared storage `s`. */
const CASE_PRELUDE = `import { each, type EachFilter, type Storage, type Tag } from "../../src/ecstatic/index.js";
import type { ComponentDescriptor } from "../../src/ecstatic/component.js";
import { Enemy } from "../archetypes.js";
import { Boost, Shield, Stunned } from "../components.js";
import { Position } from "../position.js";
import { Glow, type GlowFilter } from "../glow.js";
import { sharedFilter } from "../filter-value.js";
declare const s: Storage<typeof Enemy>;
`;

/** A component whose name type is declared in its own file, which no storage type reaches. */
const GLOW_SOURCE = `import type { ComponentDescriptor } from "../src/ecstatic/component.js";

export interface GlowDescriptor extends ComponentDescriptor {
  readonly __ecstatic_name: "Glow";
}
export declare const Glow: GlowDescriptor;
export interface GlowFilter {
  readonly all: readonly [GlowDescriptor];
}
`;

/** A filter value declared in its own file, typed by the runtime's filter type. */
const FILTER_VALUE_SOURCE = `import type { EachFilter } from "../src/ecstatic/index.js";

export declare const sharedFilter: EachFilter;
`;

/** A literal element as the test reads it: the element's source text and its component name. */
interface ElementSummary {
  readonly node: string;
  readonly name: string;
}

/** A filter fact with every node ID replaced by its node's source text. */
type FilterSummary =
  | {
      readonly kind: "literal";
      readonly all: readonly ElementSummary[];
      readonly any: readonly ElementSummary[];
      readonly none: readonly ElementSummary[];
    }
  | { readonly kind: "non-literal"; readonly node: string; readonly form: FilterForm };

interface LiteralCase {
  readonly name: string;
  readonly declarations?: string;
  readonly filter: string;
  readonly all?: readonly ElementSummary[];
  readonly any?: readonly ElementSummary[];
  readonly none?: readonly ElementSummary[];
}

interface NonLiteralCase {
  readonly name: string;
  readonly declarations?: string;
  readonly filter: string;
  readonly form: FilterForm;
}

/** An element whose source text is the identifier of the component it names. */
function named(name: string): ElementSummary {
  return { node: name, name };
}

const LITERAL_CASES: readonly LiteralCase[] = [
  {
    name: "a bare array as its all axis",
    filter: "[Position, Shield]",
    all: [named("Position"), named("Shield")],
  },
  {
    name: "an object with every axis",
    filter: "{ none: [Boost], all: [Position], any: [Shield, Stunned] }",
    all: [named("Position")],
    any: [named("Shield"), named("Stunned")],
    none: [named("Boost")],
  },
  {
    name: "an object omitting an axis and writing one as []",
    filter: "{ any: [], none: [Stunned] }",
    none: [named("Stunned")],
  },
  {
    name: "elements whose names come from their types",
    declarations: `declare const flag: Tag<"Flag">;\ndeclare const shields: { readonly first: typeof Shield };\n`,
    filter: "[flag, shields.first]",
    all: [
      { node: "flag", name: "Flag" },
      { node: "shields.first", name: "Shield" },
    ],
  },
];

const NON_LITERAL_CASES: readonly NonLiteralCase[] = [
  {
    name: "an array-typed binding",
    declarations: "declare const f: readonly [typeof Position];\n",
    filter: "f",
    form: "array",
  },
  {
    name: "an object-typed binding",
    declarations: "declare const f: EachFilter;\n",
    filter: "f",
    form: "object",
  },
  {
    name: "a binding typed as an array or an object",
    declarations: "declare const f: EachFilter | readonly [typeof Position];\n",
    filter: "f",
    form: "mixed",
  },
  {
    name: "an any binding",
    declarations: "declare const f: any;\n",
    filter: "f",
    form: "unsupported",
  },
  {
    name: "an unknown binding",
    declarations: "declare const f: unknown;\n",
    filter: "f",
    form: "unsupported",
  },
  {
    name: "a binding that admits null",
    declarations: "declare const f: EachFilter | null;\n",
    filter: "f",
    form: "unsupported",
  },
  {
    name: "a binding that admits undefined",
    declarations: "declare const f: EachFilter | undefined;\n",
    filter: "f",
    form: "unsupported",
  },
  {
    name: "a binding that admits a primitive",
    declarations: "declare const f: readonly [typeof Position] | number;\n",
    filter: "f",
    form: "unsupported",
  },
  {
    name: "a binding typed as a branded primitive",
    declarations: 'declare const f: number & { readonly brand: "filter" };\n',
    filter: "f",
    form: "unsupported",
  },
  {
    name: "a binding that admits a callable",
    declarations: "declare const f: EachFilter | (() => void);\n",
    filter: "f",
    form: "unsupported",
  },
  {
    name: "a shorthand axis",
    declarations: "const all = [Position] as const;\n",
    filter: "{ all }",
    form: "object",
  },
  {
    name: "an axis that is not an array literal",
    declarations: "const list = [Position] as const;\n",
    filter: "{ all: list }",
    form: "object",
  },
  { name: "a computed key", filter: '{ ["all"]: [Position] }', form: "object" },
  { name: "a repeated axis", filter: "{ all: [Position], all: [Shield] }", form: "object" },
  { name: "an omitted element", filter: "[Position, , Shield]", form: "array" },
  { name: "a key that is no axis", filter: "{ all: [Position], some: [Shield] }", form: "object" },
  {
    name: "a spread property",
    declarations: "declare const base: EachFilter;\n",
    filter: "{ ...base, none: [Stunned] }",
    form: "object",
  },
  {
    name: "a spread element",
    declarations: "const list = [Position] as const;\n",
    filter: "[...list, Shield]",
    form: "array",
  },
  {
    name: "a spread element in an axis",
    declarations: "const list = [Position] as const;\n",
    filter: "{ all: [...list] }",
    form: "object",
  },
  {
    name: "an element whose name does not resolve",
    declarations: "declare const descriptor: ComponentDescriptor;\n",
    filter: "{ all: [Position], any: [descriptor] }",
    form: "object",
  },
  {
    name: "an element whose name is a union",
    declarations: "declare const either: typeof Position | typeof Shield;\n",
    filter: "[either]",
    form: "array",
  },
];

/** The text of a case file calling `each` over `s` with `filter`, after `declarations`. */
function filteredEach(declarations: string, filter: string): string {
  return `${declarations}each(s, ${filter}, () => {});\n`;
}

const PRESENCE_SOURCE = "each(s, () => {});\neach(s, [Position], () => {});\n";

const DECLARATION_FILES_SOURCE = "each(s, () => {});\neach(s, [Glow], () => {});\n";

const OMITTED_ELEMENT_SOURCE = "each(s, [Glow, , Glow], () => {});\n";

const FOREIGN_VALUE_SOURCE = "each(s, () => {});\neach(s, sharedFilter, () => {});\n";

const FOREIGN_TYPE_SOURCE =
  "declare const f: GlowFilter;\neach(s, () => {});\neach(s, f, () => {});\n";

/** Filters typed by a type parameter, read through its constraint. */
const TYPE_PARAMETER_CASES = [
  {
    name: "an unconstrained type parameter",
    source: "function run<F>(f: F): void {\n  each(s, f, () => {});\n}\n",
    form: "unsupported",
  },
  {
    name: "a type parameter constrained to a filter object",
    source: "function run<F extends EachFilter>(f: F): void {\n  each(s, f, () => {});\n}\n",
    form: "object",
  },
] as const satisfies readonly { name: string; source: string; form: FilterForm }[];

const SOURCES = [
  ...[...LITERAL_CASES, ...NON_LITERAL_CASES].map(({ declarations = "", filter }) =>
    filteredEach(declarations, filter),
  ),
  PRESENCE_SOURCE,
  DECLARATION_FILES_SOURCE,
  FOREIGN_VALUE_SOURCE,
  FOREIGN_TYPE_SOURCE,
  OMITTED_ELEMENT_SOURCE,
  ...TYPE_PARAMETER_CASES.map(({ source }) => source),
];

const CASE_STEM = "app/filter/case";

let root = "";
let session: Session;
let view: ProjectView;

beforeAll(async () => {
  ({ root, session, view } = await openProject(
    runtimeProject({
      ...SHARED_ARCHETYPE_FILES,
      "app/glow.ts": GLOW_SOURCE,
      "app/filter-value.ts": FILTER_VALUE_SOURCE,
      ...caseFiles(CASE_STEM, SOURCES, CASE_PRELUDE),
    }),
  ));
}, SPAWN_TIMEOUT_MS);

afterAll(() => closeProject(session));

/** The `each` sites of the case file holding `source`, with the table their node IDs index. */
async function eachSites(
  source: string,
): Promise<{ readonly sites: readonly Site[]; readonly table: NodeTable }> {
  const file = await view.sourceFile(
    projectPath(root, `${CASE_STEM}${SOURCES.indexOf(source)}.ts`),
  );
  const { sites, table } = await analyze(view.checker, file, new PackageRoots());
  return { sites: sites.filter(({ op }) => op === "each"), table };
}

/** The source text of the node `table` registers under `id`. */
function nodeText(table: NodeTable, id: NodeID): string | undefined {
  return table.node(id)?.getText();
}

/** `filter` with its node IDs replaced by their nodes' source text. */
function summarizeFilter(table: NodeTable, filter: Filter | undefined): FilterSummary | undefined {
  if (filter === undefined) return undefined;
  if (filter.kind === "non-literal") {
    return { kind: "non-literal", node: nodeText(table, filter.node) ?? "", form: filter.form };
  }
  const axis = (elements: LiteralFilter["all"]): ElementSummary[] =>
    elements.map(({ node, name }) => ({ node: nodeText(table, node) ?? "", name }));
  return { kind: "literal", all: axis(filter.all), any: axis(filter.any), none: axis(filter.none) };
}

/** The summarized filter of the single `each` site of the case file holding `source`. */
async function filterOf(source: string): Promise<FilterSummary | undefined> {
  const { sites, table } = await eachSites(source);
  const [site] = sites;
  return summarizeFilter(table, site?.filter);
}

describe("each filter analysis", () => {
  it.each(LITERAL_CASES)(
    "reports $name as literal, per axis in source order",
    async ({ declarations = "", filter, all = [], any = [], none = [] }) => {
      const found = await filterOf(filteredEach(declarations, filter));

      expect(found).toStrictEqual({ kind: "literal", all, any, none });
    },
  );

  it.each(NON_LITERAL_CASES)(
    "reports $name as non-literal of form $form",
    async ({ declarations = "", filter, form }) => {
      const found = await filterOf(filteredEach(declarations, filter));

      expect(found).toStrictEqual({ kind: "non-literal", node: filter, form });
    },
  );

  it.each(TYPE_PARAMETER_CASES)(
    "reports $name as non-literal of form $form",
    async ({ source, form }) => {
      const found = await filterOf(source);

      expect(found).toStrictEqual({ kind: "non-literal", node: "f", form });
    },
  );

  it("reports a filter only for a call the filtered flag marks as passing one", async () => {
    const { sites, table } = await eachSites(PRESENCE_SOURCE);

    expect(
      sites.map((site) => ({
        filtered: site.filtered,
        filter: summarizeFilter(table, site.filter),
      })),
    ).toStrictEqual([
      { filtered: false, filter: undefined },
      {
        filtered: true,
        filter: { kind: "literal", all: [named("Position")], any: [], none: [] },
      },
    ]);
  });

  it("lists the declaration files a filter consulted among its site's", async () => {
    const glow = projectPath(root, "app/glow.ts");

    const { sites } = await eachSites(DECLARATION_FILES_SOURCE);

    expect(sites.map(({ declarationFiles }) => declarationFiles.includes(glow))).toStrictEqual([
      false,
      true,
    ]);
  });

  it.each([
    {
      name: "value",
      source: FOREIGN_VALUE_SOURCE,
      file: "app/filter-value.ts",
    },
    {
      name: "type",
      source: FOREIGN_TYPE_SOURCE,
      file: "app/glow.ts",
    },
  ])(
    "lists the file declaring a non-literal filter's $name among its site's declaration files",
    async ({ source, file }) => {
      const path = projectPath(root, file);

      const { sites } = await eachSites(source);

      expect(sites.map(({ declarationFiles }) => declarationFiles.includes(path))).toStrictEqual([
        false,
        true,
      ]);
    },
  );

  it("leaves the elements' declaration files out of a filter an omitted element makes non-literal", async () => {
    const glow = projectPath(root, "app/glow.ts");

    const { sites } = await eachSites(OMITTED_ELEMENT_SOURCE);

    expect(sites.map(({ declarationFiles }) => declarationFiles.includes(glow))).toStrictEqual([
      false,
    ]);
  });
});
