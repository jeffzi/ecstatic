/**
 * The view lowering of an inlined loop: what each view use of the callback body becomes once the
 * body runs as the row loop's body, and the locals the loop reads the storage through.
 *
 * Each lowering mirrors the view's accessors in `buildView` (`src/ecstatic/entity/each.ts`): the id
 * getter reads the entity array, an optional slot's getter tests the row's presence bit, a
 * required tag is `true`, and `fieldAccessorsFor` reads and writes a column at the bound row,
 * decoding and encoding booleans as 1/0. An alias holds its slot's presence, tested once at its
 * declaration, in place of the field record, whose accessors never test the bit again.
 */

import {
  type BinaryExpression,
  type Expression,
  getSynthesizedDeepClone,
  type Node,
  NodeFlags,
  type ParameterDeclaration,
  type PostfixUnaryExpression,
  type PrefixUnaryExpression,
  type Statement,
  SyntaxKind,
  type VariableDeclaration,
  type VariableDeclarationList,
} from "typescript/ast";
import {
  createElementAccessExpression,
  createIdentifier,
  createPrefixUnaryExpression,
  createVariableDeclarationList,
} from "typescript/ast/factory";
import {
  isBinaryExpression,
  isBindingElement,
  isExpression,
  isNonNullExpression,
  isPostfixUnaryExpression,
  isPrefixUnaryExpression,
  isVariableDeclaration,
} from "typescript/ast/is";
import { visitNode } from "typescript/ast/visitor";

import type { ArchShape, Field, ViewUse } from "../facts.js";
import { type NodeTable, tableNode } from "../nodes.js";
import type { Mode } from "../plan.js";
import { skipParens, skipWrappers } from "../syntax.js";
import { lowerAssign, lowerUpdate } from "./assign.js";
import type { Rule } from "./catalog.js";
import {
  binary,
  constStatement,
  declaration,
  decode,
  IDENTIFIER_NAME,
  keyword,
  letStatement,
  member,
  numeric,
  orUndefined,
  parenthesized,
  slotOf,
  type Visit,
} from "./expressions.js";
import type { NameGenerator } from "./names.js";
import { destructure } from "./patterns.js";

/** One column the body touches: a field of a component, read through the component's record. */
interface Column {
  readonly record: string;
  readonly field: string;
  /** The hoisted local holding the column; undefined in realloc-safe mode. */
  readonly local: string | undefined;
}

function anyNode(_node: Node): _node is Node {
  return true;
}

/** The loop a {@link Lowering} lowers the body of, and where it records its names and rules. */
export interface LoopFrame {
  readonly shape: ArchShape;
  /** Whether the loop hoists the storage's arrays. */
  readonly mode: Mode;
  readonly names: NameGenerator;
  /** The loop's applied rules, which the lowerings add to. */
  readonly applied: Set<Rule>;
  /** The name of the local holding the storage. */
  readonly storage: string;
  /** The name of the row index. */
  readonly row: string;
}

/**
 * The storage reads and view-use lowerings of one inlined loop. Its public members past
 * {@link Lowering.lower} are the row accessors the sibling lowerings of assignments and patterns
 * build from.
 */
export class Lowering {
  /** Whether the loop hoists the storage's arrays. */
  readonly mode: Mode;
  readonly #shape: ArchShape;
  readonly #names: NameGenerator;
  readonly #applied: Set<Rule>;
  readonly #storage: string;
  readonly #row: string;
  readonly #uses = new Map<Node, ViewUse>();
  /** The record local of each component the body touches, in the order its uses first name them. */
  readonly #records = new Map<string, string>();
  /** The columns the body touches, keyed by component and field, in the order its uses first name them. */
  readonly #columns = new Map<string, Column>();
  readonly #temps: string[] = [];
  /** The base name of every local the loop declares. */
  readonly #bases: string[] = [];
  #entities: string | undefined;
  #mask: string | undefined;

  /** @param frame - The loop. */
  constructor({ shape, mode, names, applied, storage, row }: LoopFrame) {
    this.#shape = shape;
    this.mode = mode;
    this.#names = names;
    this.#applied = applied;
    this.#storage = storage;
    this.#row = row;
  }

  /**
   * Records the use whose node `table` maps, so {@link Lowering.lower} lowers that node, and the
   * record and column of its field. Collecting the uses in source order declares the records and
   * columns in the order the body names them, whatever order the lowerings later reach them in.
   *
   * @param table - The file's node table.
   * @param use - The view use.
   * @throws Error when `table` holds no node of the use.
   */
  collect(table: NodeTable, use: ViewUse): void {
    this.#uses.set(tableNode(table, use.node, "view use", anyNode), use);
    if (use.kind !== "id" && use.field !== "") this.#column(use);
  }

  /**
   * The view use of a node.
   *
   * @param node - A node of the body.
   * @returns The use whose node is `node`, or undefined when it is none.
   */
  useOf(node: Node): ViewUse | undefined {
    return this.#uses.get(node);
  }

  /** The base names of every local the loop's storage reads and lowerings declared. */
  get baseNames(): readonly string[] {
    return this.#bases;
  }

  /**
   * The statements declaring, once per call, the record of every component the body touched, read
   * through the storage's per-component alias; in hoisted mode every touched column, the entity
   * array, and the presence mask; and the temps the lowerings hold values in. Call it once the
   * body is lowered.
   *
   * @returns The statements, in that order.
   */
  hoists(): Statement[] {
    const statements: Statement[] = [];
    const records = [...this.#records].map(([comp, name]) =>
      declaration(name, member(createIdentifier(this.#storage), comp)),
    );
    const hoisted = [...this.#columns.values()].flatMap(({ record, field, local }) =>
      local === undefined ? [] : [declaration(local, member(createIdentifier(record), field))],
    );
    for (const [name, array] of [
      [this.#entities, "entities"],
      [this.#mask, "mask"],
    ] as const) {
      if (name !== undefined) hoisted.push(declaration(name, this.#storageArray(array)));
    }
    for (const declarations of [records, hoisted]) {
      if (declarations.length > 0) statements.push(constStatement(declarations));
    }
    if (this.#temps.length > 0) {
      statements.push(letStatement(this.#temps.map((name) => declaration(name))));
    }
    return statements;
  }

  /**
   * The lowering of `node`, the node of `use`. A `destructure` use lowers with its declaration
   * list, through {@link Lowering.declarationList}.
   *
   * @param node - The node of the use.
   * @param use - The view use.
   * @param visit - Visits the parts of `node` the body evaluates.
   * @returns What `node` becomes.
   * @throws Error when the use has no lowering, `node` is not the node its kind spans, the loop's
   *   shape has no field the use reads or writes, a use through an alias has no slot expression,
   *   or an alias binds no name.
   */
  lower(node: Node, use: ViewUse, visit: Visit): Node {
    switch (use.kind) {
      case "id":
        return this.idValue();
      case "field-read":
        return this.#fieldRead(slotOf(node, use), use);
      case "optional-read":
        return this.#optionalRead(slotOf(node, use), use);
      case "field-assign":
        return lowerAssign(this, narrow(node, isBinaryExpression, use), use, visit);
      case "field-update":
        return lowerUpdate(this, narrow(node, isUpdateExpression, use), use);
      case "presence":
        this.noteSlot(use, "presence-required", "presence-optional");
        return this.present(use, narrow(node, isExpression, use));
      case "compare":
        return this.#compare(narrow(node, isBinaryExpression, use), use);
      case "coalesce":
        return this.#coalesce(narrow(node, isBinaryExpression, use), use, visit);
      case "tag":
        return this.tagValue(use, narrow(node, isExpression, use));
      case "alias":
        if (isVariableDeclaration(node)) {
          this.note("alias");
          this.noteNonNull(node.initializer);
        }
        return this.aliasDeclaration(node, use);
      case "destructure":
        break;
    }
    throw noLowering(use);
  }

  /**
   * The lowering of a `const` or `let` declaration list some of whose declarations destructure the
   * view or a slot.
   *
   * @param list - A declaration list of the body.
   * @param visit - Visits the parts of the list the body evaluates.
   * @returns The list with each destructuring declaration replaced by the declarations binding its
   *   pattern, or undefined when no declaration of `list` destructures.
   * @throws Error when a destructuring has no lowering, the loop's shape has no field a pattern
   *   reads, or an alias in a pattern binds no name.
   */
  declarationList(list: VariableDeclarationList, visit: Visit): Node | undefined {
    const destructures = list.declarations.some((d) => this.#uses.get(d)?.kind === "destructure");
    if (!destructures) return undefined;
    const declarations = list.declarations.flatMap((node) => {
      const use = this.#uses.get(node);
      if (use?.kind === "destructure")
        return destructure({ lowering: this, site: "declaration", visit }, node, use);
      return [visitNode(node, visit, isVariableDeclaration)];
    });
    const flags = list.flags & (NodeFlags.Let | NodeFlags.Const | NodeFlags.Using);
    return createVariableDeclarationList(declarations, flags);
  }

  /**
   * The declarations binding the pattern of a callback parameter that destructures the view.
   *
   * @param parameter - The callback's view parameter.
   * @param visit - Visits the defaults the pattern evaluates.
   * @returns The declarations, in pattern order, or undefined when the parameter does not
   *   destructure the view.
   * @throws Error when the destructuring has no lowering, the loop's shape has no field the pattern
   *   reads, or an alias in the pattern binds no name.
   */
  parameterBindings(
    parameter: ParameterDeclaration,
    visit: Visit,
  ): VariableDeclaration[] | undefined {
    const use = this.#uses.get(parameter.name);
    if (use === undefined) return undefined;
    return destructure({ lowering: this, site: "parameter", visit }, parameter.name, use);
  }

  /**
   * The id of the row, as the id getter reads it from the entity array.
   *
   * @returns `entities[i]`.
   */
  idValue(): Expression {
    this.note("entity-id");
    return this.atRow(this.#entityArray());
  }

  /**
   * The value of a tag.
   *
   * @param use - The tag use.
   * @param slot - The slot expression of the use, read when the use goes through an alias.
   * @returns `true` for a required tag, else `(present ? true : undefined)`.
   * @throws Error when the use goes through an alias with no slot expression.
   */
  tagValue(use: ViewUse, slot: Expression | undefined): Expression {
    this.noteSlot(use, "required-tag", "optional-tag");
    const isTrue = keyword(SyntaxKind.TrueKeyword);
    return this.isOptional(use.comp) ? orUndefined(this.present(use, slot), isTrue) : isTrue;
  }

  /**
   * The declaration of a slot alias, which holds the slot's presence.
   *
   * @param node - The alias's `const` declaration or pattern element.
   * @param use - The alias use.
   * @returns `name = present`.
   * @throws Error when `node` binds no name.
   */
  aliasDeclaration(node: Node, use: ViewUse): VariableDeclaration {
    if ((isVariableDeclaration(node) || isBindingElement(node)) && node.name !== undefined) {
      return declaration(node.name, this.present(use, node.initializer));
    }
    throw new Error(`emit: the alias of ${use.comp} binds no name`);
  }

  /**
   * Records a rule the loop applies.
   *
   * @param rule - The rule.
   */
  note(rule: Rule): void {
    this.#applied.add(rule);
  }

  /**
   * Records the rule of a use's slot.
   *
   * @param use - The view use.
   * @param required - The rule when the slot is a required component's.
   * @param optional - The rule when it is an optional component's.
   */
  noteSlot(use: ViewUse, required: Rule, optional: Rule): void {
    this.note(this.isOptional(use.comp) ? optional : required);
  }

  /**
   * Records the non-null-asserted slot rule when a slot expression is `e.C!`.
   *
   * @param slot - The slot expression of a field use or an alias.
   */
  noteNonNull(slot: Expression | undefined): void {
    if (slot !== undefined && isNonNullExpression(skipParens(slot))) this.note("non-null-slot");
  }

  /**
   * Whether the slot of a use is enabled at the row, as the optional slot getter tests it.
   *
   * @param use - The view use.
   * @param slot - The slot expression of the use, read when the use goes through an alias.
   * @returns `true` for a required component; the alias, whose declaration holds the presence it
   *   tested, for a use through one; and otherwise the test of the optional's bit in the mask.
   * @throws Error when the use goes through an alias with no slot expression.
   */
  present(use: ViewUse, slot: Expression | undefined): Expression {
    if (use.alias) {
      if (slot === undefined) throw new Error(`emit: the alias use of ${use.comp} has no slot`);
      return getSynthesizedDeepClone(skipWrappers(slot));
    }
    const index = this.#shape.optional.findIndex(({ name }) => name === use.comp);
    if (index < 0) return keyword(SyntaxKind.TrueKeyword);
    const masked = binary(
      this.atRow(this.#maskArray()),
      SyntaxKind.AmpersandToken,
      numeric(String(2 ** index)),
    );
    return decode(parenthesized(masked));
  }

  /**
   * The column of the field of a use, guarded by its slot's presence.
   *
   * @param use - The view use.
   * @param slot - The slot expression of the use.
   * @returns The column; for an optional component `(present ? column : undefined)`, which throws
   *   a TypeError when indexed while the slot is disabled, as reading a field of the getter's
   *   `undefined` does.
   * @throws Error when the use goes through an alias with no slot expression.
   */
  guardedColumn(use: ViewUse, slot: Expression | undefined): Expression {
    if (!this.isOptional(use.comp)) return this.columnArray(use);
    return orUndefined(this.present(use, slot), this.columnArray(use));
  }

  /**
   * The field of a use read from a column at the row.
   *
   * @param use - The view use.
   * @param array - The column.
   * @returns The element, decoded for a boolean field.
   * @throws Error when the shape has no such field.
   */
  read(use: ViewUse, array: Expression): Expression {
    const element = this.atRow(array);
    return this.field(use).kind === "boolean" ? decode(element) : element;
  }

  /**
   * An array's element at the row.
   *
   * @param array - The array.
   * @returns `array[i]`.
   */
  atRow(array: Expression): Expression {
    return createElementAccessExpression(
      array,
      undefined,
      createIdentifier(this.#row),
      NodeFlags.None,
    );
  }

  /**
   * The column of the field of a use. Reaching the column of a relation's data field records that
   * rule.
   *
   * @param use - The view use.
   * @returns The hoisted column, or in realloc-safe mode the record's current one.
   */
  columnArray(use: ViewUse): Expression {
    const isRelation = this.#components().some(
      ({ name, relation }) => name === use.comp && relation,
    );
    if (isRelation) this.note("relation-data-field");
    const column = this.#column(use);
    return column.local === undefined
      ? member(createIdentifier(column.record), column.field)
      : createIdentifier(column.local);
  }

  /**
   * Whether a component is one of the shape's optionals.
   *
   * @param comp - The component's name.
   * @returns Whether it is optional.
   */
  isOptional(comp: string): boolean {
    return this.#shape.optional.some(({ name }) => name === comp);
  }

  /**
   * The field a use reads or writes.
   *
   * @param use - The view use.
   * @returns The field in the loop's shape.
   * @throws Error when the shape has no such field.
   */
  field(use: ViewUse): Field {
    const field = this.#components()
      .flatMap(({ name, fields }) => (name === use.comp ? fields : []))
      .find(({ name }) => name === use.field);
    if (field === undefined) {
      throw new Error(`emit: the shape has no field ${use.comp}.${use.field}`);
    }
    return field;
  }

  /**
   * A fresh local a lowering holds a value in, declared once per call.
   *
   * @param base - The name the local is named after.
   * @returns Its name.
   */
  temp(base: string): string {
    const name = this.#local(base);
    this.#temps.push(name);
    return name;
  }

  #fieldRead(slot: Expression, use: ViewUse): Expression {
    this.noteSlot(use, "read-required-field", "read-optional-field");
    this.noteNonNull(slot);
    if (this.field(use).kind === "boolean") this.note("read-boolean-field");
    return this.read(use, this.guardedColumn(use, slot));
  }

  #optionalRead(slot: Expression, use: ViewUse): Expression {
    const read = this.read(use, this.columnArray(use));
    if (!this.isOptional(use.comp)) return read;
    this.note("optional-chain-read");
    return orUndefined(this.present(use, slot), read);
  }

  /**
   * A slot coalesced in a test position, where the record is truthy and `undefined` falsy.
   *
   * @param node - The `??` expression.
   * @param use - The coalesce use.
   * @param visit - Visits the right-hand side.
   * @returns `(present || right)`.
   */
  #coalesce(node: BinaryExpression, use: ViewUse, visit: Visit): Expression {
    this.noteSlot(use, "coalesce-required", "coalesce-optional");
    const right = visitNode(node.right, visit, isExpression);
    return parenthesized(binary(this.present(use, node.left), SyntaxKind.BarBarToken, right));
  }

  /**
   * A comparison of a slot with `null` or `undefined`: the slot is the field record or
   * `undefined`, never `null`.
   *
   * @param node - The comparison.
   * @param use - The compare use.
   * @returns A constant for a strict comparison with `null`, else the slot's presence or its
   *   negation.
   * @throws Error when `use` names no slot operand.
   */
  #compare(node: BinaryExpression, use: ViewUse): Expression {
    const [slot, other] = compareOperands(node, use);
    const operator = node.operatorToken.kind;
    const strict =
      operator === SyntaxKind.EqualsEqualsEqualsToken ||
      operator === SyntaxKind.ExclamationEqualsEqualsToken;
    if (strict && skipWrappers(other).kind === SyntaxKind.NullKeyword) {
      const equal = operator === SyntaxKind.EqualsEqualsEqualsToken;
      this.note(equal ? "compare-null-strict-equal" : "compare-null-strict-not-equal");
      return keyword(equal ? SyntaxKind.FalseKeyword : SyntaxKind.TrueKeyword);
    }
    this.noteSlot(use, "presence-required", "presence-optional");
    const present = this.present(use, slot);
    if (
      operator === SyntaxKind.EqualsEqualsEqualsToken ||
      operator === SyntaxKind.EqualsEqualsToken
    ) {
      return parenthesized(negate(present));
    }
    return present;
  }

  #entityArray(): Expression {
    if (this.mode === "realloc-safe") return this.#storageArray("entities");
    this.#entities ??= this.#local("entities");
    return createIdentifier(this.#entities);
  }

  #maskArray(): Expression {
    if (this.mode === "realloc-safe") return this.#storageArray("mask");
    this.#mask ??= this.#local("mask");
    return createIdentifier(this.#mask);
  }

  #column(use: ViewUse): Column {
    const key = `${use.comp}\u0000${use.field}`;
    let column = this.#columns.get(key);
    if (column === undefined) {
      const record = this.#record(use.comp);
      const local = this.mode === "hoisted" ? this.#local(`${use.field}Column`) : undefined;
      column = { record, field: use.field, local };
      this.#columns.set(key, column);
    }
    return column;
  }

  #record(comp: string): string {
    let record = this.#records.get(comp);
    if (record === undefined) {
      record = this.#local(IDENTIFIER_NAME.test(comp) ? `${comp}Record` : "record");
      this.#records.set(comp, record);
    }
    return record;
  }

  #storageArray(name: string): Expression {
    return member(createIdentifier(this.#storage), name);
  }

  #components(): ArchShape["required"] {
    return [...this.#shape.required, ...this.#shape.optional];
  }

  #local(base: string): string {
    this.#bases.push(base);
    return this.#names.unique(base);
  }
}

function isUpdateExpression(node: Node): node is PrefixUnaryExpression | PostfixUnaryExpression {
  return isPrefixUnaryExpression(node) || isPostfixUnaryExpression(node);
}

/**
 * Narrows the node of a use to the kind the use spans.
 *
 * @param node - The node of the use.
 * @param test - The kind the use spans.
 * @param use - The view use.
 * @returns `node`.
 * @throws Error when `node` fails `test`.
 */
function narrow<T extends Node>(node: Node, test: (node: Node) => node is T, use: ViewUse): T {
  if (!test(node)) throw noLowering(use);
  return node;
}

function noLowering(use: ViewUse): Error {
  return new Error(
    `emit: the view use of ${use.comp}.${use.field}, kind ${use.kind}, has no lowering`,
  );
}

function negate(operand: Expression): Expression {
  return createPrefixUnaryExpression(SyntaxKind.ExclamationToken, operand);
}

/**
 * The operands of a nullish comparison, the slot first, by the side analysis recorded.
 *
 * @param node - The comparison.
 * @param use - The compare use of `node`.
 * @returns The slot operand, then the `null` or `undefined` it is compared with.
 * @throws Error when `use` names no slot operand.
 */
function compareOperands(node: BinaryExpression, use: ViewUse): [Expression, Expression] {
  if (use.slotOperand === undefined) {
    throw new Error(`emit: the compare use of ${use.comp} names no slot operand`);
  }
  return use.slotOperand === "left" ? [node.left, node.right] : [node.right, node.left];
}
