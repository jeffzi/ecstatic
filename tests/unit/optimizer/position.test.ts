import { join } from "node:path";

import { isIdentifier, type Identifier, type Node } from "typescript/ast";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { nodePosition } from "../../../src/plugin/optimizer/position.js";
import { openSession, type Session } from "../../../src/plugin/optimizer/session.js";
import { locate } from "./locate.js";
import { appTsconfig, removeProjects, writeProject } from "./project.js";

const CASES = [
  {
    name: "on the first line",
    file: "case0.ts",
    source: "has(s, s);\n",
  },
  {
    name: "after a line break",
    file: "case1.ts",
    source: "declare const s: any;\n\thas(s, s);\n",
  },
  {
    name: "after CRLF line breaks",
    file: "case2.ts",
    source: "declare const s: any;\r\ndeclare const t: any;\r\n  has(s, s);\r\n",
  },
  {
    name: "after non-ASCII and astral text",
    file: "case3.ts",
    source: 'const label = "é🚀"; has(s, s);\n',
  },
  {
    name: "after non-ASCII and astral text on an earlier line",
    file: "case4.ts",
    source: 'const label = "é🚀🚀";\nconst other = "ü"; has(s, s);\n',
  },
  {
    name: "on the first line of a file with a BOM",
    file: "case5.ts",
    source: '\uFEFFconst label = "é🚀"; has(s, s);\n',
  },
  {
    name: "after CRLF line breaks in a file with a BOM",
    file: "case6.ts",
    source: '\uFEFFconst label = "é🚀";\r\n\tconst other = "ü"; has(s, s);\r\n',
  },
];

let root = "";
let session: Session;

beforeAll(async () => {
  const placeholders = Object.fromEntries(CASES.map(({ file }) => [`app/${file}`, "export {};\n"]));
  root = writeProject({ "tsconfig.json": appTsconfig(), ...placeholders });
  session = await openSession(join(root, "tsconfig.json"));
});

afterAll(async () => {
  await session.close();
  removeProjects();
});

/** The identifiers under `node` named `name`, in source order. */
function identifiersNamed(node: Node, name: string): Identifier[] {
  const found: Identifier[] = [];
  node.forEachChild((child) => {
    if (isIdentifier(child) && child.text === name) found.push(child);
    found.push(...identifiersNamed(child, name));
  });
  return found;
}

describe("nodePosition", () => {
  it.each(CASES)(
    "gives the 1-based line and UTF-16 column of a call $name",
    async ({ source, file: name }) => {
      const file = join(root, "app", name);
      const view = await session.update({ [file]: source });
      const parsed = await view.sourceFile(file);
      const [callee] = identifiersNamed(parsed, "has");
      if (callee === undefined) throw new Error(`no call to has in ${file}`);

      const position = nodePosition(parsed, callee);

      expect(position).toStrictEqual(locate(file, source, "has(s, s)"));
    },
  );
});

describe("locate", () => {
  it.each([
    { name: "on the first line", source: "has(s, s);\n", line: 1, column: 1, offset: 0 },
    { name: "after LF", source: "a;\n\thas(s, s);\n", line: 2, column: 2, offset: 4 },
    { name: "after CRLF", source: "a;\r\nb;\r\nhas(s, s);\n", line: 3, column: 1, offset: 8 },
    { name: "after a lone CR", source: "a;\rhas(s, s);", line: 2, column: 1, offset: 3 },
    { name: "after a line separator", source: "a;\u2028has(s, s);", line: 2, column: 1, offset: 3 },
    { name: "after astral text", source: '"é🚀"; has(s, s);', line: 1, column: 8, offset: 7 },
    { name: "after a BOM", source: "\uFEFFa; has(s, s);", line: 1, column: 4, offset: 4 },
  ])("gives the position $name", ({ source, line, column, offset }) => {
    const position = locate("main.ts", source, "has(s, s)");

    expect(position).toStrictEqual({ file: "main.ts", offset, line, column });
  });

  it("finds a later occurrence", () => {
    const position = locate("main.ts", "has(s, s);\nhas(s, s);\n", "has(s, s)", 1);

    expect(position).toStrictEqual({ file: "main.ts", offset: 11, line: 2, column: 1 });
  });

  it("throws naming the text when it occurs too few times", () => {
    const locating = () => locate("main.ts", "has(s, s);\n", "has(s, s)", 1);

    expect(locating).toThrow('"has(s, s)"');
  });
});
