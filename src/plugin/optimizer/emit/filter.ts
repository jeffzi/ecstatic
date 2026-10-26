/**
 * The parts of an inlined loop that a literal filter adds: the temps its elements are evaluated
 * into, the `DEBUG` guard that checks each element against the storage as the fold took it, and,
 * for a Masked fold, the matcher the loop reads its row flags from.
 *
 * A Masked loop caches the storage's matcher in a slot of its own call site: an uninitialized
 * file-level `var` the call site fills with `??=`. A loop can run while its module is still
 * loading, when a circular import calls it before the module's body has run; a `var` binding
 * exists as `undefined` by then, a top-level `let` or `const` would throw. The cache is sound
 * because `matcherFor` returns the storage's existing matcher for the same masks, matchers are
 * never removed, and growth replaces `matched` on the same matcher object: the slot keeps the
 * matcher, and the loop reads `matched` from it on every call.
 */

import { type Expression, NodeFlags, type Statement, SyntaxKind } from "typescript/ast";
import {
  createBlock,
  createElementAccessExpression,
  createExpressionStatement,
  createIdentifier,
  createIfStatement,
  createObjectLiteralExpression,
  createVariableDeclarationList,
  createVariableStatement,
} from "typescript/ast/factory";
import { isExpression } from "typescript/ast/is";

import type { MaskedFold } from "../fold.js";
import { type NodeTable, tableNode } from "../nodes.js";
import type { Mode, PlannedFilter } from "../plan.js";
import type { Rule } from "./catalog.js";
import {
  assignTo,
  binary,
  commaList,
  constStatement,
  debugGated,
  declaration,
  keyword,
  letStatement,
  member,
  namespaceCall,
  numeric,
  propertyAssignment,
  undefinedValue,
} from "./expressions.js";
import type { NameGenerator } from "./names.js";

/** The base name of each local a filtered loop adds. */
export const FILTER_LOCALS = {
  element: "element",
  site: "site",
  matcher: "matcher",
  matched: "matched",
} as const;

/** What a {@link FilterPass} is built from, and where it records its names and rules. */
export interface FilterParts {
  readonly table: NodeTable;
  readonly filter: PlannedFilter;
  readonly mode: Mode;
  readonly names: NameGenerator;
  readonly applied: Set<Rule>;
  /** The name of the preamble's namespace import of the internal entry. */
  readonly namespace: string;
  /** The runtime's `DEBUG` initializer, which the element guard copies as its gate. */
  readonly debug: Expression;
}

/** One literal element, with the temp it is evaluated into and the presence the fold took. */
interface ElementTemp {
  readonly value: Expression;
  readonly temp: string;
  readonly present: boolean;
}

/** The statements and reads a literal filter adds to one inlined loop. */
export class FilterPass {
  readonly #parts: FilterParts;
  /** The elements in source order, which is the order the runtime call evaluates them in. */
  readonly #elements: readonly ElementTemp[];
  #matcher: string | undefined;
  #matched: string | undefined;
  #site: string | undefined;

  /**
   * @param parts - The loop's filter and what its statements are built from.
   * @throws Error when an element of the filter is not in the node table or is no expression.
   */
  constructor(parts: FilterParts) {
    this.#parts = parts;
    const { table, filter, names } = parts;
    const located = filter.elements.map((element, index) => ({
      value: tableNode(table, element.node, "filter element", isExpression),
      present: filter.fold.present[index] === true,
    }));
    this.#elements = located
      .toSorted((a, b) => a.value.pos - b.value.pos)
      .map(({ value, present }) => ({ value, present, temp: names.unique(FILTER_LOCALS.element) }));
    parts.applied.add(`filter-${filter.fold.kind}`);
    if (this.#elements.length > 0) parts.applied.add("filter-element-guard");
  }

  /** Whether the fold leaves no row the loop could visit, so it runs no row loop at all. */
  get skips(): boolean {
    return this.#parts.filter.fold.kind === "skip";
  }

  /**
   * The name of the file-level slot the loop caches its matcher in, once {@link FilterPass.matcher}
   * has taken it.
   */
  get site(): string | undefined {
    return this.#site;
  }

  /**
   * The statement evaluating every element into its temp, in source order, as the runtime call
   * evaluates its filter argument.
   *
   * @returns The `const` statement, or none for a filter without elements.
   */
  temps(): Statement[] {
    if (this.#elements.length === 0) return [];
    return [constStatement(this.#elements.map(({ temp, value }) => declaration(temp, value)))];
  }

  /**
   * The `DEBUG` check that each element is in the storage's component set exactly when the fold
   * took it as present. Its gate is a parenthesized copy of the runtime's `DEBUG` initializer, and
   * it reads no binding of the file but the namespace import and the loop's own locals.
   *
   * @param storage - The name of the loop's storage local.
   * @returns `(<DEBUG initializer>) && (<namespace>.assertFilterMember(storage, element, present),
   *   ...)`, or none for a filter without elements.
   */
  guard(storage: string): Statement[] {
    if (this.#elements.length === 0) return [];
    const { namespace, debug } = this.#parts;
    const checks = this.#elements.map(({ temp, present }) =>
      namespaceCall(namespace, "assertFilterMember", [
        createIdentifier(storage),
        createIdentifier(temp),
        keyword(present ? SyntaxKind.TrueKeyword : SyntaxKind.FalseKeyword),
      ]),
    );
    const last = checks.pop();
    if (last === undefined) return [];
    return [createExpressionStatement(debugGated(debug, commaList(...checks, last)))];
  }

  /**
   * For a Masked fold, the statements that read the storage's matcher for the folded masks from the
   * call site's slot, calling `matcherFor` only when the slot holds another storage. The matcher is
   * registered before the row count is tested, as the runtime resolves the filter before it.
   *
   * @param storage - The name of the loop's storage local.
   * @returns The statements, or none when the fold is not Masked.
   */
  matcher(storage: string): Statement[] {
    const { fold } = this.#parts.filter;
    if (fold.kind !== "masked") return [];
    const { names } = this.#parts;
    const site = names.unique(FILTER_LOCALS.site);
    const matcher = names.unique(FILTER_LOCALS.matcher);
    this.#site = site;
    this.#matcher = matcher;
    const slot = (key: "s" | "m"): Expression => member(createIdentifier(site), key);
    const empty = createObjectLiteralExpression(
      [
        propertyAssignment(createIdentifier("s"), undefinedValue()),
        propertyAssignment(createIdentifier("m"), undefinedValue()),
      ],
      false,
    );
    return [
      createExpressionStatement(
        binary(createIdentifier(site), SyntaxKind.QuestionQuestionEqualsToken, empty),
      ),
      letStatement([declaration(matcher, slot("m"))]),
      createIfStatement(
        binary(slot("s"), SyntaxKind.ExclamationEqualsEqualsToken, createIdentifier(storage)),
        createBlock(
          [
            createExpressionStatement(
              assignTo(createIdentifier(matcher), this.#matcherFor(storage, fold)),
            ),
            createExpressionStatement(assignTo(slot("s"), createIdentifier(storage))),
            createExpressionStatement(assignTo(slot("m"), createIdentifier(matcher))),
          ],
          true,
        ),
      ),
    ];
  }

  /**
   * In hoisted mode, the statement reading the matcher's row flags into a local once per call: a
   * hoisted body never grows the storage, and `enable` and `disable` write into that same array.
   *
   * @returns The statement, or none in realloc-safe mode or without a matcher.
   */
  hoists(): Statement[] {
    const matcher = this.#matcher;
    if (matcher === undefined || this.#parts.mode !== "hoisted") return [];
    const matched = this.#parts.names.unique(FILTER_LOCALS.matched);
    this.#matched = matched;
    return [constStatement([declaration(matched, member(createIdentifier(matcher), "matched"))])];
  }

  /**
   * The test a row must pass to be visited, which reads the row's flag when the loop reaches it:
   * in realloc-safe mode through the matcher, whose `matched` growth replaces.
   *
   * @param row - The name of the row index.
   * @returns `matched[i] !== 0`, or `undefined` when the loop visits every row.
   */
  rowTest(row: string): Expression | undefined {
    const matcher = this.#matcher;
    if (matcher === undefined) return undefined;
    const flags =
      this.#matched === undefined
        ? member(createIdentifier(matcher), "matched")
        : createIdentifier(this.#matched);
    const flag = createElementAccessExpression(
      flags,
      undefined,
      createIdentifier(row),
      NodeFlags.None,
    );
    return binary(flag, SyntaxKind.ExclamationEqualsEqualsToken, numeric("0"));
  }

  /**
   * `matcherFor(storage, all, any, none)` through the namespace import.
   *
   * @param storage - The name of the loop's storage local.
   * @param fold - The Masked fold whose masks are passed.
   * @returns The call.
   */
  #matcherFor(storage: string, fold: MaskedFold): Expression {
    return namespaceCall(this.#parts.namespace, "matcherFor", [
      createIdentifier(storage),
      numeric(String(fold.all)),
      numeric(String(fold.any)),
      numeric(String(fold.none)),
    ]);
  }
}

/**
 * The file-level declaration of call-site slots, left uninitialized so a loop that runs before the
 * module's body finds them `undefined` rather than in their temporal dead zone.
 *
 * @param sites - The slots' names.
 * @returns `var site, ...;`.
 */
export function siteDeclarations(sites: readonly string[]): Statement {
  return createVariableStatement(
    undefined,
    createVariableDeclarationList(
      sites.map((site) => declaration(site)),
      NodeFlags.None,
    ),
  );
}
