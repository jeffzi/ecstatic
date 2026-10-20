import { type Expression, type Node, type Statement, SyntaxKind } from "typescript/ast";
import {
  isExpressionStatement,
  isNonNullExpression,
  isParenthesizedExpression,
  isVariableStatement,
} from "typescript/ast/is";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { ProjectView, Session } from "../../../src/plugin/optimizer/session.js";
import {
  arithmeticOperator,
  boundNames,
  logicalOperator,
  outermostParens,
  skipWrappers,
} from "../../../src/plugin/optimizer/syntax.js";
import {
  appTsconfig,
  caseFiles,
  closeProject,
  openProject,
  projectPath,
  SPAWN_TIMEOUT_MS,
} from "./project.js";

const SKIP_CASES = [
  { name: "a bare expression", source: "x;", expected: SyntaxKind.Identifier },
  {
    name: "parentheses and non-null assertions",
    source: "((x)!)!;",
    expected: SyntaxKind.Identifier,
  },
  { name: "a type assertion", source: "(x as T);", expected: SyntaxKind.AsExpression },
];

const PARENS_CASES = [
  { name: "nested parentheses return the outermost", source: "((x));", from: 2, expected: 0 },
  { name: "a non-null assertion stops the walk", source: "(x!);", from: 2, expected: 2 },
];

const BOUND_CASES = [
  {
    name: "nested patterns",
    source: "const {a, b: [c, d = 1], ...e} = v;",
    expected: ["a", "c", "d", "e"],
  },
  { name: "an array elision", source: "const [a, , b] = v;", expected: ["a", "b"] },
];

const SOURCES = [...SKIP_CASES, ...PARENS_CASES, ...BOUND_CASES].map(({ source }) => source);

/** An assignment operator and the binary operators it maps to; `undefined` when it has none. */
interface AssignmentOperator {
  readonly token: string;
  readonly operator: SyntaxKind;
  readonly arithmetic: SyntaxKind | undefined;
  readonly logical: SyntaxKind | undefined;
}

/** A compound assignment of an arithmetic or bitwise operator. */
function arithmeticAssignment(
  token: string,
  operator: SyntaxKind,
  arithmetic: SyntaxKind,
): AssignmentOperator {
  return { token, operator, arithmetic, logical: undefined };
}

/** A compound assignment of a logical operator. */
function logicalAssignment(
  token: string,
  operator: SyntaxKind,
  logical: SyntaxKind,
): AssignmentOperator {
  return { token, operator, arithmetic: undefined, logical };
}

const ASSIGNMENT_OPERATORS: readonly AssignmentOperator[] = [
  { token: "=", operator: SyntaxKind.EqualsToken, arithmetic: undefined, logical: undefined },
  arithmeticAssignment("+=", SyntaxKind.PlusEqualsToken, SyntaxKind.PlusToken),
  arithmeticAssignment("-=", SyntaxKind.MinusEqualsToken, SyntaxKind.MinusToken),
  arithmeticAssignment("*=", SyntaxKind.AsteriskEqualsToken, SyntaxKind.AsteriskToken),
  arithmeticAssignment(
    "**=",
    SyntaxKind.AsteriskAsteriskEqualsToken,
    SyntaxKind.AsteriskAsteriskToken,
  ),
  arithmeticAssignment("/=", SyntaxKind.SlashEqualsToken, SyntaxKind.SlashToken),
  arithmeticAssignment("%=", SyntaxKind.PercentEqualsToken, SyntaxKind.PercentToken),
  arithmeticAssignment(
    "<<=",
    SyntaxKind.LessThanLessThanEqualsToken,
    SyntaxKind.LessThanLessThanToken,
  ),
  arithmeticAssignment(
    ">>=",
    SyntaxKind.GreaterThanGreaterThanEqualsToken,
    SyntaxKind.GreaterThanGreaterThanToken,
  ),
  arithmeticAssignment(
    ">>>=",
    SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken,
    SyntaxKind.GreaterThanGreaterThanGreaterThanToken,
  ),
  arithmeticAssignment("&=", SyntaxKind.AmpersandEqualsToken, SyntaxKind.AmpersandToken),
  arithmeticAssignment("|=", SyntaxKind.BarEqualsToken, SyntaxKind.BarToken),
  arithmeticAssignment("^=", SyntaxKind.CaretEqualsToken, SyntaxKind.CaretToken),
  logicalAssignment("||=", SyntaxKind.BarBarEqualsToken, SyntaxKind.BarBarToken),
  logicalAssignment(
    "&&=",
    SyntaxKind.AmpersandAmpersandEqualsToken,
    SyntaxKind.AmpersandAmpersandToken,
  ),
  logicalAssignment(
    "??=",
    SyntaxKind.QuestionQuestionEqualsToken,
    SyntaxKind.QuestionQuestionToken,
  ),
];

const CASE_STEM = "app/case";

let root = "";
let session: Session;
let view: ProjectView;

beforeAll(async () => {
  ({ root, session, view } = await openProject({
    "tsconfig.json": appTsconfig(),
    ...caseFiles(CASE_STEM, SOURCES),
  }));
}, SPAWN_TIMEOUT_MS);

afterAll(() => closeProject(session));

/** The first statement of the case file holding `source`. */
async function firstStatement(source: string): Promise<Statement> {
  const file = await view.sourceFile(
    projectPath(root, `${CASE_STEM}${SOURCES.indexOf(source)}.ts`),
  );
  const [statement] = file.statements;
  if (statement === undefined) throw new Error(`${source} holds no statement`);
  return statement;
}

/** The expression of the expression statement `source`. */
async function expressionOf(source: string): Promise<Expression> {
  const statement = await firstStatement(source);
  if (!isExpressionStatement(statement)) throw new Error(`${source} is not an expression`);
  return statement.expression;
}

/** The node `depth` parenthesized or non-null levels inside `expr`. */
function descend(expr: Node, depth: number): Node {
  let node = expr;
  for (let level = 0; level < depth; level++) {
    if (!isParenthesizedExpression(node) && !isNonNullExpression(node)) {
      throw new Error(`no wrapper at depth ${level}`);
    }
    node = node.expression;
  }
  return node;
}

describe("skipWrappers", () => {
  it.each(SKIP_CASES)("leaves $name as $expected", async ({ source, expected }) => {
    const expr = await expressionOf(source);

    const inner = skipWrappers(expr);

    expect(inner.kind).toBe(expected);
  });
});

describe("outermostParens", () => {
  it.each(PARENS_CASES)("$name", async ({ source, from, expected }) => {
    const expr = await expressionOf(source);

    const outermost = outermostParens(descend(expr, from));

    expect(outermost).toBe(descend(expr, expected));
  });
});

describe("boundNames", () => {
  it.each(BOUND_CASES)("lists the names bound by $name", async ({ source, expected }) => {
    const statement = await firstStatement(source);
    if (!isVariableStatement(statement)) throw new Error(`${source} is not a declaration`);
    const declaration = statement.declarationList.declarations[0];
    if (declaration === undefined) throw new Error(`${source} declares nothing`);

    const names = boundNames(declaration.name);

    expect(names).toStrictEqual(expected);
  });
});

describe("arithmeticOperator", () => {
  it.each(ASSIGNMENT_OPERATORS)(
    "maps $token to its arithmetic operator",
    ({ operator, arithmetic }) => {
      expect(arithmeticOperator(operator)).toBe(arithmetic);
    },
  );
});

describe("logicalOperator", () => {
  it.each(ASSIGNMENT_OPERATORS)("maps $token to its logical operator", ({ operator, logical }) => {
    expect(logicalOperator(operator)).toBe(logical);
  });
});
