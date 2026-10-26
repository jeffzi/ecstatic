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
import type { FoldedPlannedFilter, Mode } from "../plan.js";
import type { Rule } from "./catalog.js";
import {
  assignTo,
  binary,
  commaList,
  constStatement,
  debugGated,
  declaration,
  elementAt,
  keyword,
  letStatement,
  member,
  namespaceCall,
  numeric,
  propertyAssignment,
  undefinedValue,
} from "./expressions.js";
import type { NameGenerator } from "./names.js";

/** The base name of each local a pass adds to hold its call-site slot and matcher. */
export const MATCHER_LOCALS = { site: "site", matcher: "matcher", matched: "matched" } as const;

/** The base name of each local a filtered loop adds. */
export const FILTER_LOCALS = {
  element: "element",
  ...MATCHER_LOCALS,
} as const;

/**
 * The keys of the call-site slot a filtered loop caches its resolution in: the storage it resolved
 * against, the filter value it resolved (a non-literal filter only), and the matcher it got.
 */
export const SLOT = { storage: "s", filter: "f", matcher: "m" } as const;

/** What a loop reads from its filter's pass, whether the filter is folded or resolved at runtime. */
export interface RowFilter {
  /** Whether the pass leaves no row the loop could visit, so the loop runs no row loop at all. */
  readonly skips: boolean;
  /** The file-level slot the pass caches its resolution in, once its matcher has been read. */
  readonly site: string | undefined;
  /** The base names of the locals the pass adds to a loop. */
  readonly locals: readonly string[];
  /** The statements evaluating the filter into the temps the loop reads it from. */
  temps(): Statement[];
  /** The `DEBUG` check of the filter's elements against the storage; none for a pass without one. */
  guard(storage: string): Statement[];
  /**
   * The statements that resolve the filter against the storage into the pass's matcher, which the
   * pass caches in its call site's slot. Call it before {@link RowFilter.hoists} and
   * {@link RowFilter.rowTest}, which read the matcher it takes.
   *
   * @param storage - The name of the loop's storage local.
   * @returns The statements.
   */
  matcher(storage: string): Statement[];
  /**
   * In hoisted mode, the statement reading the matcher's row flags into a local once per call. Call
   * it after {@link RowFilter.matcher} and before {@link RowFilter.rowTest}, which reads the local.
   *
   * @returns The statement, or none in realloc-safe mode.
   */
  hoists(): Statement[];
  /**
   * The test a row must pass to be visited. Call it after {@link RowFilter.matcher} and
   * {@link RowFilter.hoists}.
   *
   * @param row - The name of the row index.
   * @returns The test, or `undefined` when the loop visits every row.
   */
  rowTest(row: string): Expression | undefined;
}

/**
 * A member of a call-site slot.
 *
 * @param site - The name of the slot's file-level variable.
 * @param key - The slot key.
 * @returns `site.key`.
 */
function slotRead(site: string, key: string): Expression {
  return member(createIdentifier(site), key);
}

/**
 * The statement that fills a call-site slot on its first run.
 *
 * @param site - The name of the slot's file-level variable.
 * @param keys - The slot keys, in the order they are declared.
 * @returns `site ??= { key: void 0, ... };`.
 */
export function slotInit(site: string, keys: readonly string[]): Statement {
  const empty = createObjectLiteralExpression(
    keys.map((key) => propertyAssignment(createIdentifier(key), undefinedValue())),
    false,
  );
  return createExpressionStatement(
    binary(createIdentifier(site), SyntaxKind.QuestionQuestionEqualsToken, empty),
  );
}

/** The names {@link MatcherSlot.take} chose, and the reader of the slot's members. */
interface TakenSlot {
  /** The name of the slot's file-level variable. */
  readonly site: string;
  /** The name of the local holding the matcher. */
  readonly matcher: string;
  /** A member of the slot. */
  readonly slot: (key: string) => Expression;
}

/**
 * The names a pass gives its call-site slot, its matcher local, and the local its matcher's row
 * flags are hoisted into, once the pass has taken them.
 */
export class MatcherSlot {
  #site: string | undefined;
  #matcher: string | undefined;
  #matched: string | undefined;

  /** The name of the slot's file-level variable, once {@link MatcherSlot.take} has run. */
  get site(): string | undefined {
    return this.#site;
  }

  /** The name of the matcher local, once {@link MatcherSlot.take} has run. */
  get matcher(): string | undefined {
    return this.#matcher;
  }

  /** The name of the local the row flags are hoisted into, once {@link MatcherSlot.hoists} ran. */
  get matched(): string | undefined {
    return this.#matched;
  }

  /**
   * Chooses the names of the slot and of the matcher local, in that order.
   *
   * @param names - The generator the names are drawn from.
   * @returns The two names and a reader of the slot's members.
   */
  take(names: NameGenerator): TakenSlot {
    const site = names.unique(MATCHER_LOCALS.site);
    const matcher = names.unique(MATCHER_LOCALS.matcher);
    this.#site = site;
    this.#matcher = matcher;
    return { site, matcher, slot: (key) => slotRead(site, key) };
  }

  /**
   * In hoisted mode, the statement reading the matcher's row flags into a local once per call.
   *
   * @param mode - The loop's mode.
   * @param names - The generator the local's name is drawn from.
   * @returns The statement, or none in realloc-safe mode or before {@link MatcherSlot.take} has run.
   */
  hoists(mode: Mode, names: NameGenerator): Statement[] {
    const matcher = this.#matcher;
    if (matcher === undefined || mode !== "hoisted") return [];
    const matched = names.unique(MATCHER_LOCALS.matched);
    this.#matched = matched;
    return [hoistFlags(matcher, matched)];
  }
}

/** What a {@link FilterPass} is built from, and where it records its names and rules. */
export interface FilterParts {
  readonly table: NodeTable;
  readonly filter: FoldedPlannedFilter;
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
export class FilterPass implements RowFilter {
  readonly locals: readonly string[] = Object.values(FILTER_LOCALS);
  readonly #parts: FilterParts;
  /** The elements in source order, which is the order the runtime call evaluates them in. */
  readonly #elements: readonly ElementTemp[];
  readonly #slot = new MatcherSlot();

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
    return this.#slot.site;
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
    const { site, matcher, slot } = this.#slot.take(this.#parts.names);
    return [
      slotInit(site, [SLOT.storage, SLOT.matcher]),
      letStatement([declaration(matcher, slot(SLOT.matcher))]),
      createIfStatement(
        binary(
          slot(SLOT.storage),
          SyntaxKind.ExclamationEqualsEqualsToken,
          createIdentifier(storage),
        ),
        createBlock(
          [
            createExpressionStatement(
              assignTo(createIdentifier(matcher), this.#matcherFor(storage, fold)),
            ),
            createExpressionStatement(assignTo(slot(SLOT.storage), createIdentifier(storage))),
            createExpressionStatement(assignTo(slot(SLOT.matcher), createIdentifier(matcher))),
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
    return this.#slot.hoists(this.#parts.mode, this.#parts.names);
  }

  /**
   * The test a row must pass to be visited, which reads the row's flag when the loop reaches it:
   * in realloc-safe mode through the matcher, whose `matched` growth replaces.
   *
   * @param row - The name of the row index.
   * @returns `matched[i] !== 0`, or `undefined` when the loop visits every row.
   */
  rowTest(row: string): Expression | undefined {
    const matcher = this.#slot.matcher;
    if (matcher === undefined) return undefined;
    return rowFlagTest(matcher, this.#slot.matched, row);
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
 * The test a row must pass to be visited under a matcher, reading the row's flag when the loop
 * reaches it.
 *
 * @param matcher - The name of the matcher local.
 * @param matched - The name of the local the matcher's flags are hoisted into, or `undefined` to read
 *   them through the matcher, whose `matched` growth replaces.
 * @param row - The name of the row index.
 * @returns `matched[i] !== 0`.
 */
export function rowFlagTest(matcher: string, matched: string | undefined, row: string): Expression {
  const flags = matched === undefined ? matcherFlags(matcher) : createIdentifier(matched);
  const flag = elementAt(flags, createIdentifier(row));
  return binary(flag, SyntaxKind.ExclamationEqualsEqualsToken, numeric("0"));
}

/**
 * The statement reading a matcher's row flags into a local, once per call.
 *
 * @param matcher - The name of the matcher local.
 * @param matched - The name of the local the flags are read into.
 * @returns `const matched = matcher.matched;`.
 */
function hoistFlags(matcher: string, matched: string): Statement {
  return constStatement([declaration(matched, matcherFlags(matcher))]);
}

/**
 * A matcher's row flags.
 *
 * @param matcher - The name of the matcher local.
 * @returns `matcher.matched`.
 */
function matcherFlags(matcher: string): Expression {
  return member(createIdentifier(matcher), "matched");
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
