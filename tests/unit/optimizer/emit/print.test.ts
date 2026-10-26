import { SourceMap } from "node:module";
import { basename } from "node:path";

import {
  type Expression,
  isExpressionStatement,
  type Node,
  NodeFlags,
  type SourceFile,
  type Statement,
  TokenFlags,
} from "typescript/ast";
import {
  createBlock,
  createCallExpression,
  createExpressionStatement,
  createIdentifier,
  createNumericLiteral,
  createVariableDeclaration,
  createVariableDeclarationList,
  createVariableStatement,
} from "typescript/ast/factory";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { printSpliced, type Replacement } from "../../../../src/plugin/optimizer/emit/print.js";
import type { Session } from "../../../../src/plugin/optimizer/session.js";
import { locate } from "../locate.js";
import {
  appTsconfig,
  caseFile,
  caseFiles,
  closeProject,
  openProject,
  projectPath,
  SPAWN_TIMEOUT_MS,
} from "../project.js";

const CASE_COUNT = 20;

/** The path prefix of every case file, before its index. */
const CASE_STEM = "app/case";

/** The text the preamble of {@link preamble} prints as, its lines joined by `\n`. */
const PREAMBLE_TEXT = "const DEBUG = 1;\nconst shapeKey = 2;";

const PREAMBLE_LINES = PREAMBLE_TEXT.split("\n");

/**
 * A statement whose template literals continue over several lines, beside a string literal
 * continued by an escaped line break, which the printer prints joined.
 */
const MULTI_LINE_LITERALS = [
  "seen.push(`x ${e.x}",
  "  indented \"${'a\\",
  "b'}\" ${`",
  "`}",
  "end`);",
];

const LINE_BREAK = /\r\n|[\n\r\u2028\u2029]/gu;

let root = "";
let session: Session;
let nextCase = 0;

beforeAll(async () => {
  const placeholders = caseFiles(
    CASE_STEM,
    Array.from({ length: CASE_COUNT }, () => "export {};\n"),
  );
  ({ root, session } = await openProject({ "tsconfig.json": appTsconfig(), ...placeholders }));
}, SPAWN_TIMEOUT_MS);

afterAll(() => closeProject(session));

/** Serves `text` as a case file of its own and returns the file's path and parsed source. */
async function load(text: string): Promise<{ file: string; source: SourceFile }> {
  const file = projectPath(root, caseFile(CASE_STEM, nextCase++));
  const view = await session.update({ [file]: text });
  return { file, source: await view.sourceFile(file) };
}

/** A `const` statement binding `name` to the number `value`. */
function constant(name: string, value: string): Statement {
  return createVariableStatement(
    undefined,
    createVariableDeclarationList(
      [
        createVariableDeclaration(
          createIdentifier(name),
          undefined,
          undefined,
          createNumericLiteral(value, TokenFlags.None),
        ),
      ],
      NodeFlags.Const,
    ),
  );
}

/** Preamble statements that print as {@link PREAMBLE_TEXT}. */
function preamble(): Statement[] {
  return [constant("DEBUG", "1"), constant("shapeKey", "2")];
}

/** The call `inlined(0)`. */
function inlinedCall(): Expression {
  return createCallExpression(
    createIdentifier("inlined"),
    undefined,
    undefined,
    [createNumericLiteral("0", TokenFlags.None)],
    NodeFlags.None,
  );
}

/** The statement `inlined(0);`. */
function inlinedStatement(): Statement {
  return createExpressionStatement(inlinedCall());
}

/**
 * The first node under `tree`, in source order, whose text is exactly `text`.
 *
 * In a file served with a byte order mark, the compiler's positions count the mark while the
 * source's `text` drops it, so `node.getText()` reads the wrong characters.
 *
 * @param tree - The tree searched.
 * @param text - The exact text to match.
 * @param served - The served text, read in place of `node.getText()` when it opens with a byte
 *   order mark: the node's full text with leading whitespace trimmed, which matches nodes preceded
 *   by whitespace only.
 * @returns The first matching node, in source order.
 * @throws Error when no node has that text.
 */
function nodeWithText(tree: Node, text: string, served = ""): Node {
  const textOf = served.startsWith("\uFEFF")
    ? (node: Node): string => served.slice(node.pos, node.end).trimStart()
    : (node: Node): string => node.getText();
  let found: Node | undefined;
  const visit = (node: Node): void => {
    if (found !== undefined) return;
    if (textOf(node) === text) {
      found = node;
      return;
    }
    node.forEachChild(visit);
  };
  tree.forEachChild(visit);
  if (found === undefined) throw new Error(`no node with text ${JSON.stringify(text)}`);
  return found;
}

/** The expression statement under `tree` whose text is exactly `text`. */
function statementWithText(tree: Node, text: string): Statement {
  const node = nodeWithText(tree, text);
  if (!isExpressionStatement(node)) throw new Error(`${JSON.stringify(text)} is no statement`);
  return node;
}

/** The 0-based line and UTF-16 column of `index` in `text`, lines ending as the compiler ends them. */
function positionIn(text: string, index: number): { line: number; column: number } {
  const before = text.slice(0, index);
  const breaks = [...before.matchAll(LINE_BREAK)];
  const lineStart = Math.max(0, ...breaks.map((match) => match.index + match[0].length));
  return { line: breaks.length, column: index - lineStart };
}

describe("printSpliced", () => {
  describe("when loops replace statements", () => {
    it.each<{
      name: string;
      source: string;
      targets: readonly { text: string; node: () => Node }[];
      expected: string;
    }>([
      {
        name: "comments on the lines before and after a top-level statement",
        source: [
          "keep(  1 ,2 );",
          "// Before the inlined call.",
          "each(list, (e) => {",
          "  e.x += 1;",
          "}); // after it",
          "keep(3);",
          "",
        ].join("\n"),
        targets: [{ text: "each(list, (e) => {\n  e.x += 1;\n});", node: inlinedStatement }],
        expected: [
          PREAMBLE_TEXT,
          "keep(  1 ,2 );",
          "// Before the inlined call.",
          "inlined(0); // after it",
          "keep(3);",
          "",
        ].join("\n"),
      },
      {
        name: "a nested statement and an arrow function's body",
        source: [
          "each(list, [Velocity], () => {",
          "  /* kept */ each(list, (inner) => {",
          "    inner.x = 3;",
          "  });",
          "});",
          "const run = () => each(list, (e) => { e.x += 1; });",
          "",
        ].join("\n"),
        targets: [
          {
            text: "each(list, (inner) => {\n    inner.x = 3;\n  });",
            node: inlinedStatement,
          },
          { text: "each(list, (e) => { e.x += 1; })", node: inlinedCall },
        ],
        expected: [
          PREAMBLE_TEXT,
          "each(list, [Velocity], () => {",
          "  /* kept */ inlined(0);",
          "});",
          "const run = () => inlined(0);",
          "",
        ].join("\n"),
      },
      {
        name: "a byte order mark",
        source: "\uFEFFkeep(1);\neach(list, (e) => {\n  e.x += 1;\n}); // after it\n",
        targets: [{ text: "each(list, (e) => {\n  e.x += 1;\n});", node: inlinedStatement }],
        expected: `\uFEFF${PREAMBLE_TEXT}\nkeep(1);\ninlined(0); // after it\n`,
      },
    ])("keeps every other byte around $name", async ({ source: text, targets, expected }) => {
      const { source } = await load(text);
      const replacements: Replacement[] = targets.map((target) => ({
        target: nodeWithText(source, target.text, text),
        node: target.node(),
      }));

      const printed = await printSpliced(session, source, preamble(), replacements);

      expect(printed.text).toBe(expected);
    });

    it("prints no comment from inside a replaced statement", async () => {
      const { source } = await load(
        [
          "// before",
          "each(list, (e) => {",
          "  // inside the body",
          "  e.x += 1; /* trailing inside */",
          "});",
          "// after",
          "",
        ].join("\n"),
      );
      const body = statementWithText(source, "e.x += 1;");
      const replacements: Replacement[] = [
        {
          target: nodeWithText(
            source,
            "each(list, (e) => {\n  // inside the body\n  e.x += 1; /* trailing inside */\n});",
          ),
          node: createBlock([body], true),
        },
      ];

      const printed = await printSpliced(session, source, preamble(), replacements);

      expect(printed.text).toContain("e.x += 1;");
      expect(printed.text).toContain("// before\n");
      expect(printed.text).toContain("// after\n");
      expect(printed.text).not.toContain("inside");
    });

    it.each<{
      name: string;
      newline: string;
      lines: readonly string[];
      target: readonly string[];
      body: readonly string[];
      expected: readonly string[];
    }>([
      {
        name: "a statement indented with spaces",
        newline: "\n",
        lines: [
          "each(list, [Velocity], () => {",
          "  each(list, (inner) => {",
          "    inner.x = 3;",
          "  });",
          "});",
          "",
        ],
        target: ["each(list, (inner) => {", "    inner.x = 3;", "  });"],
        body: ["inner.x = 3;"],
        expected: [
          ...PREAMBLE_LINES,
          "each(list, [Velocity], () => {",
          "  {",
          "      inner.x = 3;",
          "  }",
          "});",
          "",
        ],
      },
      {
        name: "a statement indented with tabs",
        newline: "\n",
        lines: [
          "each(list, [Velocity], () => {",
          "\teach(list, (inner) => {",
          "\t\tinner.x = 3;",
          "\t});",
          "});",
          "",
        ],
        target: ["each(list, (inner) => {", "\t\tinner.x = 3;", "\t});"],
        body: ["inner.x = 3;"],
        expected: [
          ...PREAMBLE_LINES,
          "each(list, [Velocity], () => {",
          "\t{",
          "\t    inner.x = 3;",
          "\t}",
          "});",
          "",
        ],
      },
      {
        name: "a statement whose body holds multi-line string and template literals",
        newline: "\n",
        lines: [
          "if (list.n > 0) {",
          "    each(list, (e) => {",
          `        ${MULTI_LINE_LITERALS[0]}`,
          ...MULTI_LINE_LITERALS.slice(1),
          "    });",
          "}",
          "",
        ],
        target: [
          "each(list, (e) => {",
          `        ${MULTI_LINE_LITERALS[0]}`,
          ...MULTI_LINE_LITERALS.slice(1),
          "    });",
        ],
        body: MULTI_LINE_LITERALS,
        expected: [
          ...PREAMBLE_LINES,
          "if (list.n > 0) {",
          "    {",
          `        ${MULTI_LINE_LITERALS[0]}`,
          "  indented \"${'ab'}\" ${`",
          ...MULTI_LINE_LITERALS.slice(3),
          "    }",
          "}",
          "",
        ],
      },
      {
        name: "a statement in a CRLF source whose body holds a multi-line template literal",
        newline: "\r\n",
        lines: [
          "const rows: string[] = [];",
          "if (rows) {",
          "  each(list, (e) => {",
          "    rows.push(`row",
          "${e.id}`);",
          "  });",
          "}",
          "",
        ],
        target: ["each(list, (e) => {", "    rows.push(`row", "${e.id}`);", "  });"],
        body: ["rows.push(`row", "${e.id}`);"],
        expected: [
          ...PREAMBLE_LINES,
          "const rows: string[] = [];",
          "if (rows) {",
          "  {",
          "      rows.push(`row",
          "${e.id}`);",
          "  }",
          "}",
          "",
        ],
      },
    ])(
      "indents each continuation line of $name as its line, except inside a literal",
      async ({ newline, lines, target, body, expected }) => {
        const { source } = await load(lines.join(newline));
        const replacements: Replacement[] = [
          {
            target: nodeWithText(source, target.join(newline)),
            node: createBlock([statementWithText(source, body.join(newline))], true),
          },
        ];

        const printed = await printSpliced(session, source, preamble(), replacements);

        expect(printed.text).toBe(expected.join(newline));
      },
    );
  });

  describe("when replaced statements overlap", () => {
    it("throws an error naming the file", async () => {
      const { file, source } = await load(
        "each(list, (e) => {\n  each(list, (inner) => {\n    inner.x = 3;\n  });\n});\n",
      );
      const replacements: Replacement[] = [
        {
          target: nodeWithText(
            source,
            "each(list, (e) => {\n  each(list, (inner) => {\n    inner.x = 3;\n  });\n});",
          ),
          node: inlinedStatement(),
        },
        {
          target: nodeWithText(source, "each(list, (inner) => {\n    inner.x = 3;\n  });"),
          node: inlinedStatement(),
        },
      ];

      const printing = printSpliced(session, source, preamble(), replacements);

      await expect(printing).rejects.toThrow(basename(file));
    });
  });

  describe("when placing the preamble", () => {
    it.each([
      {
        name: "at the start of a file with neither shebang nor prologue",
        source: "each(list);\n",
        expected: `${PREAMBLE_TEXT}\ninlined(0);\n`,
      },
      {
        name: "after the shebang",
        source: "#!/usr/bin/env node\neach(list);\n",
        expected: `#!/usr/bin/env node\n${PREAMBLE_TEXT}\ninlined(0);\n`,
      },
      {
        name: "after the directive prologue",
        source: '"use strict";\n// Opens the file.\neach(list);\n',
        expected: `"use strict";\n${PREAMBLE_TEXT}\n// Opens the file.\ninlined(0);\n`,
      },
      {
        name: "after the directive prologue that follows a shebang",
        source: '#!/usr/bin/env node\n"use strict";\neach(list);\n',
        expected: `#!/usr/bin/env node\n"use strict";\n${PREAMBLE_TEXT}\ninlined(0);\n`,
      },
    ])("puts it $name", async ({ source: text, expected }) => {
      const { source } = await load(text);
      const replacements: Replacement[] = [
        { target: nodeWithText(source, "each(list);"), node: inlinedStatement() },
      ];

      const printed = await printSpliced(session, source, preamble(), replacements);

      expect(printed.text).toBe(expected);
    });
  });

  describe("when the source ends lines with CRLF", () => {
    it("ends every printed line with CRLF", async () => {
      const text = [
        "const rows: string[] = [];",
        "each(list, (e) => {",
        "  rows.push(`row",
        "${e.id}`);",
        "  e.x += 1;",
        "});",
        "",
      ].join("\r\n");
      const { source } = await load(text);
      const body = [
        statementWithText(source, "rows.push(`row\r\n${e.id}`);"),
        statementWithText(source, "e.x += 1;"),
      ];
      const replacements: Replacement[] = [
        {
          target: nodeWithText(
            source,
            "each(list, (e) => {\r\n  rows.push(`row\r\n${e.id}`);\r\n  e.x += 1;\r\n});",
          ),
          node: createBlock(body, true),
        },
      ];

      const printed = await printSpliced(session, source, preamble(), replacements);

      expect(printed.text).toContain("e.x += 1;");
      expect(printed.text.replaceAll("\r\n", "")).not.toMatch(/[\n\r]/u);
    });
  });

  describe("when nothing is inlined", () => {
    it("returns the source text unchanged", async () => {
      const text = '"use strict";\n// A comment.\neach(list, (e) => {\n  e.x  +=  1;\n});\n';
      const { source } = await load(text);

      const printed = await printSpliced(session, source, [], []);

      expect(printed.text).toBe(text);
    });
  });

  describe("source map", () => {
    const TEXT = [
      'const label = "é🚀"; each(list, (e) => {',
      "  e.x += 1;",
      "});",
      'const tail = "ü🚀"; after();',
      "",
    ].join("\n");

    it.each([
      {
        name: "the loop's opening brace to the start of the statement it replaces",
        find: (text: string) => text.indexOf("{", text.indexOf("🚀")),
        original: "each(list",
      },
      {
        name: "the loop's body line to the start of the statement it replaces",
        find: (text: string) => text.indexOf("e.x += 1;"),
        original: "each(list",
      },
      {
        name: "the loop's closing brace to the start of the statement it replaces",
        find: (text: string) => text.indexOf("}", text.indexOf("e.x")),
        original: "each(list",
      },
      {
        name: "a token after the loop to its own position",
        find: (text: string) => text.indexOf("after()"),
        original: "after()",
      },
    ])("maps $name", async ({ find, original }) => {
      const { file, source } = await load(TEXT);
      const replacements: Replacement[] = [
        {
          target: nodeWithText(source, "each(list, (e) => {\n  e.x += 1;\n});"),
          node: createBlock([statementWithText(source, "e.x += 1;")], true),
        },
      ];
      const expected = locate(file, TEXT, original);

      const printed = await printSpliced(session, source, preamble(), replacements);

      const { line, column } = positionIn(printed.text, find(printed.text));
      expect(new SourceMap(printed.map).findEntry(line, column)).toMatchObject({
        generatedLine: line,
        generatedColumn: column,
        originalLine: expected.line - 1,
        originalColumn: expected.column - 1,
      });
    });
  });
});
