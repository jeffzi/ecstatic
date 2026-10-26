/**
 * The parts of an inlined loop that a non-literal filter adds: the temp the filter is evaluated
 * into, the runtime's argument check, and the resolution of the filter against the storage, which
 * picks the unfiltered loop, the filtered one, or neither, as `eachStorage` and
 * `eachStorageMatched` (`src/ecstatic/entity/each.ts`) do.
 *
 * The resolution is cached in a slot of the call site, an uninitialized file-level `var` the call
 * site fills with `??=`, so a loop that runs before its module's body still finds it. The slot
 * holds a snapshot of the last resolution's inputs: the storage, the filter object, each axis, and
 * a copy of each axis's elements. A call whose inputs are all `===` to the snapshot's reuses its
 * matcher. That is sound because `resolveFilterMasks` depends only on the storage's fixed component
 * maps and on the listed components. The hit check is written out at the call site, never behind a
 * helper call, and each axis is read once per call, so a getter on an axis runs once, as it does
 * when the runtime's `normalizeFilter` reads it.
 */

import { type Expression, NodeFlags, type Statement, SyntaxKind } from "typescript/ast";
import {
  createArrayLiteralExpression,
  createBlock,
  createExpressionStatement,
  createForStatement,
  createIdentifier,
  createIfStatement,
  createKeywordExpression,
  createObjectLiteralExpression,
  createPostfixUnaryExpression,
  createPrefixUnaryExpression,
  createSpreadElement,
  createTypeOfExpression,
  createVariableDeclarationList,
} from "typescript/ast/factory";
import { isExpression } from "typescript/ast/is";

import { type NodeTable, tableNode } from "../nodes.js";
import type { Mode, RuntimePlannedFilter } from "../plan.js";
import type { Rule } from "./catalog.js";
import {
  assignTo,
  binary,
  conditional,
  constStatement,
  declaration,
  elementAt,
  keyword,
  letStatement,
  member,
  namespaceCall,
  numeric,
  propertyAssignment,
  string,
  undefinedValue,
} from "./expressions.js";
import { hoistFlags, type RowFilter, rowFlagTest } from "./filter.js";
import type { NameGenerator } from "./names.js";

/** The base name of each local a loop with a non-literal filter adds. */
export const RUNTIME_FILTER_LOCALS = {
  filter: "filter",
  array: "array",
  all: "all",
  any: "any",
  none: "none",
  allIds: "allIds",
  anyIds: "anyIds",
  noneIds: "noneIds",
  hit: "hit",
  ids: "ids",
  index: "k",
  site: "site",
  matcher: "matcher",
  matched: "matched",
} as const;

/** The axes of a filter, in the order `normalizeFilter` reads them and `resolveFilterMasks` takes them. */
const AXES = ["all", "any", "none"] as const;

type AxisKey = (typeof AXES)[number];

/** The snapshot key, and the base name of the local, of each axis's elements as resolved. */
const IDS = { all: "allIds", any: "anyIds", none: "noneIds" } as const satisfies Record<
  AxisKey,
  string
>;

/** What a {@link RuntimeFilterPass} is built from, and where it records its names and rules. */
export interface RuntimeFilterParts {
  readonly table: NodeTable;
  readonly filter: RuntimePlannedFilter;
  readonly mode: Mode;
  readonly names: NameGenerator;
  readonly applied: Set<Rule>;
  /** The name of the preamble's namespace import of the internal entry. */
  readonly namespace: string;
}

/** One axis the loop reads from the filter value. */
interface Axis {
  readonly key: AxisKey;
  /** The name of the local holding the axis as read: the filter's own for a component array. */
  readonly local: string;
  /**
   * The name of the local holding the axis as resolved, an empty array in place of an absent one;
   * `undefined` for a component array's one axis, which is never absent.
   */
  readonly resolved: string | undefined;
}

/** The locals the snapshot compare of one axis reads and writes. */
interface CompareLocals {
  readonly hit: string;
  readonly ids: string;
  readonly index: string;
}

/**
 * `name` as an identifier.
 *
 * @param name - The name.
 * @returns The identifier.
 */
function id(name: string): Expression {
  return createIdentifier(name);
}

/**
 * An element read by index.
 *
 * @param array - The name of the array local.
 * @param index - The name of the index local.
 * @returns `array[index]`.
 */
function at(array: string, index: string): Expression {
  return elementAt(id(array), id(index));
}

/**
 * Strict equality.
 *
 * @param left - The left operand.
 * @param right - The right operand.
 * @returns `left === right`.
 */
function same(left: Expression, right: Expression): Expression {
  return binary(left, SyntaxKind.EqualsEqualsEqualsToken, right);
}

/**
 * Every operand joined by `&&`.
 *
 * @param operands - The operands, first to last.
 * @returns `first && ... && last`.
 */
function every(...operands: readonly [Expression, ...Expression[]]): Expression {
  return operands.reduce((all, next) => binary(all, SyntaxKind.AmpersandAmpersandToken, next));
}

/**
 * A fresh array, its elements spread from an iterable, as `resolveFilterMasks` iterates an axis.
 *
 * @param iterable - The iterable.
 * @returns `[...iterable]`.
 */
function copied(iterable: Expression): Expression {
  return createArrayLiteralExpression([createSpreadElement(iterable)], false);
}

/**
 * An empty array, which `resolveFilterMasks` reads as an unconstrained axis.
 *
 * @returns `[]`.
 */
function emptyArray(): Expression {
  return createArrayLiteralExpression([], false);
}

/** The statements and reads a non-literal filter adds to one inlined loop. */
export class RuntimeFilterPass implements RowFilter {
  /** A filter resolved at runtime may match, so the loop is always built. */
  readonly skips = false;
  readonly #parts: RuntimeFilterParts;
  readonly #value: Expression;
  readonly #filter: string;
  #matcher: string | undefined;
  #matched: string | undefined;
  #site: string | undefined;

  /**
   * @param parts - The loop's filter and what its statements are built from.
   * @throws Error when the filter expression is not in the node table or is no expression.
   */
  constructor(parts: RuntimeFilterParts) {
    this.#parts = parts;
    const { table, filter, names, applied } = parts;
    this.#value = tableNode(table, filter.node, "filter", isExpression);
    this.#filter = names.unique(RUNTIME_FILTER_LOCALS.filter);
    applied.add("filter-runtime");
    applied.add(`filter-runtime-${filter.form}`);
  }

  /**
   * The name of the file-level slot the loop caches its resolution in, once
   * {@link RuntimeFilterPass.matcher} has taken it.
   */
  get site(): string | undefined {
    return this.#site;
  }

  /**
   * The statements evaluating the filter into its temp, then throwing as the runtime's `each` does
   * when the value is not an object or is `null`.
   *
   * @returns `const filter = <filter>;` and the argument check.
   */
  temps(): Statement[] {
    const notObject = binary(
      binary(
        createTypeOfExpression(id(this.#filter)),
        SyntaxKind.ExclamationEqualsEqualsToken,
        string("object"),
      ),
      SyntaxKind.BarBarToken,
      same(id(this.#filter), createKeywordExpression(SyntaxKind.NullKeyword)),
    );
    const thrown = namespaceCall(this.#parts.namespace, "throwInvalidEachArguments", []);
    return [
      constStatement([declaration(this.#filter, this.#value)]),
      createIfStatement(notObject, createExpressionStatement(thrown)),
    ];
  }

  /**
   * The `DEBUG` check of a literal filter's elements, which a filter resolved at runtime has no
   * counterpart of: the loop resolves by descriptor identity, as the runtime does.
   *
   * @returns No statement.
   */
  guard(): Statement[] {
    return [];
  }

  /**
   * The statements that read each axis once, compare the storage, the filter, its axes, and their
   * elements with the call site's snapshot, and on a miss resolve the axes with
   * `resolveFilterMasks` and refresh the snapshot. They run before the row count is read, as the
   * runtime resolves the filter before testing it, so a matcher is registered even on an empty
   * storage.
   *
   * @param storage - The name of the loop's storage local.
   * @returns The statements, after which the matcher local holds the resolution: `false`, the
   *   trivial matcher, or the storage's matcher for the filter's masks.
   */
  matcher(storage: string): Statement[] {
    const { names } = this.#parts;
    const site = names.unique(RUNTIME_FILTER_LOCALS.site);
    const matcher = names.unique(RUNTIME_FILTER_LOCALS.matcher);
    const hit = names.unique(RUNTIME_FILTER_LOCALS.hit);
    this.#site = site;
    this.#matcher = matcher;
    const { reads, axes } = this.#axes();
    const locals = {
      hit,
      ids: names.unique(RUNTIME_FILTER_LOCALS.ids),
      index: names.unique(RUNTIME_FILTER_LOCALS.index),
    };
    const slot = (key: string): Expression => member(id(site), key);
    // A component array is its own `all` axis, which the filter's identity already compares.
    const own = this.#parts.filter.form === "array" ? [] : axes;
    const keys = ["s", "f", ...own.map(({ key }) => key), ...axes.map(({ key }) => IDS[key]), "m"];
    const empty = createObjectLiteralExpression(
      keys.map((key) => propertyAssignment(createIdentifier(key), undefinedValue())),
      false,
    );
    const identities = every(
      same(slot("s"), id(storage)),
      same(slot("f"), id(this.#filter)),
      ...own.map(({ key, local }) => same(slot(key), id(local))),
    );
    return [
      ...reads,
      createExpressionStatement(binary(id(site), SyntaxKind.QuestionQuestionEqualsToken, empty)),
      letStatement([declaration(hit, identities)]),
      ...axes.map((axis) => this.#elementCheck(axis, slot(IDS[axis.key]), locals)),
      letStatement([declaration(matcher, slot("m"))]),
      createIfStatement(
        createPrefixUnaryExpression(SyntaxKind.ExclamationToken, id(hit)),
        createBlock(this.#miss(storage, axes, own, slot), true),
      ),
    ];
  }

  /**
   * In hoisted mode, the statement reading the matcher's row flags into a local once per call, for
   * the filtered loop alone.
   *
   * @returns The statement, or none in realloc-safe mode.
   * @throws Error when {@link RuntimeFilterPass.matcher} has not run.
   */
  hoists(): Statement[] {
    const matcher = this.#requireMatcher();
    if (this.#parts.mode !== "hoisted") return [];
    const matched = this.#parts.names.unique(RUNTIME_FILTER_LOCALS.matched);
    this.#matched = matched;
    return [hoistFlags(matcher, matched)];
  }

  /**
   * The test a row of the filtered loop must pass to be visited.
   *
   * @param row - The name of the row index.
   * @returns `matched[i] !== 0`, through the matcher in realloc-safe mode.
   * @throws Error when {@link RuntimeFilterPass.matcher} has not run.
   */
  rowTest(row: string): Expression {
    return rowFlagTest(this.#requireMatcher(), this.#matched, row);
  }

  /**
   * The branch between the two loops: the unfiltered one when the matcher's three masks are 0, as
   * `eachStorageMatched` treats the trivial matcher, the filtered one otherwise.
   *
   * @param unfiltered - The loop visiting every row.
   * @param filtered - The statements of the loop visiting the rows the matcher flags.
   * @returns `if (<masks are 0>) { unfiltered } else { filtered }`.
   * @throws Error when {@link RuntimeFilterPass.matcher} has not run.
   */
  branch(unfiltered: Statement, filtered: Statement[]): Statement {
    const matcher = this.#requireMatcher();
    const zero = (mask: string): Expression => same(member(id(matcher), mask), numeric("0"));
    const trivial = every(zero("allMask"), zero("anyMask"), zero("noneMask"));
    return createIfStatement(trivial, createBlock([unfiltered], true), createBlock(filtered, true));
  }

  /**
   * The statements run when the filter resolved to a matcher, as the runtime returns before reading
   * the row count when the resolution is `false`.
   *
   * @param statements - The row count read and the loops.
   * @returns `if (matcher !== false) { statements }`.
   * @throws Error when {@link RuntimeFilterPass.matcher} has not run.
   */
  whenResolved(statements: Statement[]): Statement {
    const resolved = binary(
      id(this.#requireMatcher()),
      SyntaxKind.ExclamationEqualsEqualsToken,
      keyword(SyntaxKind.FalseKeyword),
    );
    return createIfStatement(resolved, createBlock(statements, true));
  }

  /**
   * The axes the filter's form reads, and the statements reading them once each: none for a
   * component array, which is its own `all` axis; each key of a filter object; and, for a value that
   * may be either, each key unless `Array.isArray` holds, as `normalizeFilter` tells them apart.
   *
   * @returns The statements and the axes.
   */
  #axes(): { reads: Statement[]; axes: Axis[] } {
    const { form } = this.#parts.filter;
    const { names } = this.#parts;
    const filter = id(this.#filter);
    if (form === "array") {
      return { reads: [], axes: [{ key: "all", local: this.#filter, resolved: undefined }] };
    }
    const axes = AXES.map((key) => ({
      key,
      local: names.unique(RUNTIME_FILTER_LOCALS[key]),
      resolved: names.unique(RUNTIME_FILTER_LOCALS[IDS[key]]),
    }));
    if (form === "object") {
      const reads = axes.map(({ key, local }) => declaration(local, member(filter, key)));
      return { reads: [constStatement(reads)], axes };
    }
    const array = names.unique(RUNTIME_FILTER_LOCALS.array);
    const isArray = namespaceCall(this.#parts.namespace, "isArray", [filter]);
    const read = (key: AxisKey): Expression =>
      conditional(id(array), key === "all" ? filter : undefinedValue(), member(filter, key));
    return {
      reads: [
        constStatement([declaration(array, isArray)]),
        constStatement(axes.map(({ key, local }) => declaration(local, read(key)))),
      ],
      axes,
    };
  }

  /**
   * The check that an axis holds the elements of the snapshot's copy, by length and by index,
   * clearing the hit flag on the first difference. An axis that may be absent is checked only when
   * present: an absent one is already `===` to the snapshot's.
   *
   * @param axis - The axis checked.
   * @param copy - The snapshot's copy of the axis's elements.
   * @param locals - The names of the hit flag, the copy's local, and the index.
   * @returns `if (hit) { const ids = copy; hit = axis.length === ids.length; for (...) hit =
   *   axis[k] === ids[k]; }`.
   */
  #elementCheck(axis: Axis, copy: Expression, locals: CompareLocals): Statement {
    const { hit, ids, index } = locals;
    const present = binary(
      id(axis.local),
      SyntaxKind.ExclamationEqualsToken,
      createKeywordExpression(SyntaxKind.NullKeyword),
    );
    const test = axis.resolved === undefined ? id(hit) : every(id(hit), present);
    const length = (array: string): Expression => member(id(array), "length");
    const loop = createForStatement(
      createVariableDeclarationList([declaration(index, numeric("0"))], NodeFlags.Let),
      every(id(hit), binary(id(index), SyntaxKind.LessThanToken, length(ids))),
      createPostfixUnaryExpression(id(index), SyntaxKind.PlusPlusToken),
      createExpressionStatement(assignTo(id(hit), same(at(axis.local, index), at(ids, index)))),
    );
    const block = [
      constStatement([declaration(ids, copy)]),
      createExpressionStatement(assignTo(id(hit), same(length(axis.local), length(ids)))),
      loop,
    ];
    return createIfStatement(test, createBlock(block, true));
  }

  /**
   * The statements of a miss: each axis defaulted to an empty array when absent, its resolution
   * through `resolveFilterMasks`, and the snapshot's refresh. The snapshot is written only once the
   * resolution returned, so a throw leaves it as it was.
   *
   * @param storage - The name of the loop's storage local.
   * @param axes - The axes the filter's form reads.
   * @param own - The axes the snapshot keeps apart from the filter's identity.
   * @param slot - A member of the call site's slot.
   * @returns The statements.
   */
  #miss(
    storage: string,
    axes: readonly Axis[],
    own: readonly Axis[],
    slot: (key: string) => Expression,
  ): Statement[] {
    const matcher = this.#requireMatcher();
    const defaults = axes.flatMap(({ local, resolved }) =>
      resolved === undefined
        ? []
        : [
            declaration(
              resolved,
              binary(id(local), SyntaxKind.QuestionQuestionToken, emptyArray()),
            ),
          ],
    );
    const resolvedOf = (axis: Axis): Expression => id(axis.resolved ?? axis.local);
    const args = AXES.map((key) => {
      const axis = axes.find((candidate) => candidate.key === key);
      return axis === undefined ? emptyArray() : resolvedOf(axis);
    });
    const assignments = [
      assignTo(
        id(matcher),
        namespaceCall(this.#parts.namespace, "resolveFilterMasks", [id(storage), ...args]),
      ),
      assignTo(slot("s"), id(storage)),
      assignTo(slot("f"), id(this.#filter)),
      ...own.map(({ key, local }) => assignTo(slot(key), id(local))),
      ...axes.map((axis) => assignTo(slot(IDS[axis.key]), copied(resolvedOf(axis)))),
      assignTo(slot("m"), id(matcher)),
    ];
    return [
      ...(defaults.length === 0 ? [] : [constStatement(defaults)]),
      ...assignments.map((assignment) => createExpressionStatement(assignment)),
    ];
  }

  /**
   * The matcher local's name.
   *
   * @returns The name {@link RuntimeFilterPass.matcher} took.
   * @throws Error when {@link RuntimeFilterPass.matcher} has not run.
   */
  #requireMatcher(): string {
    const matcher = this.#matcher;
    if (matcher === undefined) {
      throw new Error("emit: a non-literal filter's matcher is read before it is resolved");
    }
    return matcher;
  }
}
