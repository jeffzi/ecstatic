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
import { makeFilter, sharedFilter } from "../filter-value.js";
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

/** A filter value and a filter factory declared in their own file, typed by the runtime's filter type. */
const FILTER_VALUE_SOURCE = `import type { EachFilter } from "../src/ecstatic/index.js";

export declare const sharedFilter: EachFilter;
export declare function makeFilter(): EachFilter;
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

interface FilterCase {
  readonly name: string;
  readonly declarations?: string;
  readonly filter: string;
  readonly source?: string;
}

interface LiteralCase extends FilterCase {
  readonly all?: readonly ElementSummary[];
  readonly any?: readonly ElementSummary[];
  readonly none?: readonly ElementSummary[];
}

interface NonLiteralCase extends FilterCase {
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
  {
    name: "an unconstrained type parameter",
    source: "function run<F>(f: F): void {\n  each(s, f, () => {});\n}\n",
    filter: "f",
    form: "unsupported",
  },
  {
    name: "a type parameter constrained to a filter object",
    source: "function run<F extends EachFilter>(f: F): void {\n  each(s, f, () => {});\n}\n",
    filter: "f",
    form: "object",
  },
  {
    name: "a binding typed object, which a component array satisfies",
    declarations: "declare const f: object;\n",
    filter: "f",
    form: "mixed",
  },
  {
    name: "a binding typed Object, whose members a component array has",
    declarations: "declare const f: Object;\n",
    filter: "f",
    form: "mixed",
  },
];

/** A case's file text: its `source`, else `each` over `s` with its `filter` after `declarations`. */
function filteredEach({ declarations = "", filter, source }: FilterCase): string {
  return source ?? `${declarations}each(s, ${filter}, () => {});\n`;
}

const PRESENCE_SOURCE = "each(s, () => {});\neach(s, [Position], () => {});\n";

const DECLARATION_FILES_SOURCE = "each(s, () => {});\neach(s, [Glow], () => {});\n";

const OMITTED_ELEMENT_SOURCE = "each(s, [Glow, , Glow], () => {});\n";

const OMITTED_AXIS_ELEMENT_SOURCE = "each(s, { all: [Glow, , Glow] }, () => {});\n";

const FOREIGN_VALUE_SOURCE = "each(s, () => {});\neach(s, sharedFilter, () => {});\n";

const FOREIGN_CALL_SOURCE = "each(s, () => {});\neach(s, makeFilter(), () => {});\n";

const FOREIGN_TYPE_SOURCE =
  "declare const f: GlowFilter;\neach(s, () => {});\neach(s, f, () => {});\n";

const SOURCES = [
  ...[...LITERAL_CASES, ...NON_LITERAL_CASES].map(filteredEach),
  PRESENCE_SOURCE,
  DECLARATION_FILES_SOURCE,
  FOREIGN_VALUE_SOURCE,
  FOREIGN_CALL_SOURCE,
  FOREIGN_TYPE_SOURCE,
  OMITTED_ELEMENT_SOURCE,
  OMITTED_AXIS_ELEMENT_SOURCE,
];

const CASE_STEM = "app/filter/case";

const GLOW_PATH = "app/glow.ts";

const FILTER_VALUE_PATH = "app/filter-value.ts";

let root = "";
let session: Session;
let view: ProjectView;

beforeAll(async () => {
  ({ root, session, view } = await openProject(
    runtimeProject({
      ...SHARED_ARCHETYPE_FILES,
      [GLOW_PATH]: GLOW_SOURCE,
      [FILTER_VALUE_PATH]: FILTER_VALUE_SOURCE,
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

/** The source text of the node `table` registers under `id`, or `""` when it registers none. */
function nodeText(table: NodeTable, id: NodeID): string {
  return table.node(id)?.getText() ?? "";
}

/** `filter` with its node IDs replaced by their nodes' source text. */
function summarizeFilter(table: NodeTable, filter: Filter | undefined): FilterSummary | undefined {
  if (filter === undefined) return undefined;
  if (filter.kind === "non-literal") {
    return { kind: "non-literal", node: nodeText(table, filter.node), form: filter.form };
  }
  const axis = (elements: LiteralFilter["all"]): ElementSummary[] =>
    elements.map(({ node, name }) => ({ node: nodeText(table, node), name }));
  return { kind: "literal", all: axis(filter.all), any: axis(filter.any), none: axis(filter.none) };
}

/** The summarized filter of the single `each` site of the case file holding `source`. */
async function filterOf(source: string): Promise<FilterSummary | undefined> {
  const { sites, table } = await eachSites(source);
  const [site] = sites;
  return summarizeFilter(table, site?.filter);
}

/** Whether each `each` site of the case file holding `source` lists `file` as a declaration file. */
async function consultsFile(source: string, file: string): Promise<boolean[]> {
  const path = projectPath(root, file);
  const { sites } = await eachSites(source);
  return sites.map(({ declarationFiles }) => declarationFiles.includes(path));
}

describe("each filter analysis", () => {
  it.each(LITERAL_CASES)("reports $name as literal, per axis in source order", async (testCase) => {
    const { all = [], any = [], none = [] } = testCase;

    const found = await filterOf(filteredEach(testCase));

    expect(found).toStrictEqual({ kind: "literal", all, any, none });
  });

  it.each(NON_LITERAL_CASES)("reports $name as non-literal of form $form", async (testCase) => {
    const found = await filterOf(filteredEach(testCase));

    expect(found).toStrictEqual({
      kind: "non-literal",
      node: testCase.filter,
      form: testCase.form,
    });
  });

  it("reports a filter only for a call that passes one", async () => {
    const { sites } = await eachSites(PRESENCE_SOURCE);

    expect(sites.map(({ filter }) => filter?.kind)).toStrictEqual([undefined, "literal"]);
  });

  it.each([
    {
      name: "lists the declaration files a filter consulted among its site's",
      source: DECLARATION_FILES_SOURCE,
      file: GLOW_PATH,
      expected: [false, true],
    },
    {
      name: "lists the file declaring a non-literal filter's value among its site's declaration files",
      source: FOREIGN_VALUE_SOURCE,
      file: FILTER_VALUE_PATH,
      expected: [false, true],
    },
    {
      name: "lists the file declaring the function a non-literal filter calls among its site's declaration files",
      source: FOREIGN_CALL_SOURCE,
      file: FILTER_VALUE_PATH,
      expected: [false, true],
    },
    {
      name: "lists the file declaring a non-literal filter's type among its site's declaration files",
      source: FOREIGN_TYPE_SOURCE,
      file: GLOW_PATH,
      expected: [false, true],
    },
    {
      name: "leaves the elements' declaration files out of a filter an omitted element makes non-literal",
      source: OMITTED_ELEMENT_SOURCE,
      file: GLOW_PATH,
      expected: [false],
    },
    {
      name: "leaves the elements' declaration files out of a filter object an omitted element makes non-literal",
      source: OMITTED_AXIS_ELEMENT_SOURCE,
      file: GLOW_PATH,
      expected: [false],
    },
  ])("$name", async ({ source, file, expected }) => {
    const found = await consultsFile(source, file);

    expect(found).toStrictEqual(expected);
  });
});
