/**
 * The lowering of writes to a field of the view: assignments, compound and logical assignments,
 * and updates, in the order the field accessors of `fieldAccessorsFor`
 * (`src/ecstatic/entity/each.ts`) see them.
 */

import {
  type BinaryExpression,
  type Expression,
  type PostfixUnaryExpression,
  type PrefixUnaryExpression,
  SyntaxKind,
} from "typescript/ast";
import {
  createIdentifier,
  createPostfixUnaryExpression,
  createPrefixUnaryExpression,
} from "typescript/ast/factory";
import { isExpression, isPrefixUnaryExpression } from "typescript/ast/is";
import { visitNode } from "typescript/ast/visitor";

import type { ViewUse } from "../facts.js";
import { arithmeticOperator, logicalOperator } from "../syntax.js";
import {
  assignTo,
  binary,
  commaList,
  decode,
  encode,
  isValueUsed,
  orUndefined,
  parenthesized,
  slotOf,
  type Visit,
} from "./expressions.js";
import type { Lowering } from "./lowering.js";

/** A field assignment and what every lowering of it reads about its left-hand side and value. */
interface Assigned {
  readonly node: BinaryExpression;
  readonly use: ViewUse;
  readonly slot: Expression;
  /** Whether the field stores its value encoded as 1/0. */
  readonly boolean: boolean;
  /** Whether the code around the assignment reads the value it yields. */
  readonly valueUsed: boolean;
}

/**
 * An assignment to the field of a use, keeping the order the field setter sees: the slot, then
 * the right-hand side, then the store. A boolean field stores its value encoded as 1/0, and the
 * assignment yields what the setter was given, or the decoded current value when a logical form
 * short-circuits.
 *
 * @param lowering - The loop's lowering.
 * @param node - The assignment.
 * @param use - The field-assign use.
 * @param visit - Visits the right-hand side.
 * @returns The lowered assignment.
 * @throws Error when the operator is no assignment, the left-hand side is no field access, or the
 *   loop's shape has no such field.
 */
export function lowerAssign(
  lowering: Lowering,
  node: BinaryExpression,
  use: ViewUse,
  visit: Visit,
): Expression {
  const assigned: Assigned = {
    node,
    use,
    slot: slotOf(node.left, use),
    boolean: lowering.field(use).kind === "boolean",
    valueUsed: isValueUsed(node),
  };
  lowering.noteSlot(use, "write-required-field", "write-optional-field");
  lowering.noteNonNull(assigned.slot);
  if (assigned.boolean) {
    lowering.note("write-boolean-field");
    if (assigned.valueUsed) lowering.note("boolean-assignment-value");
  }
  if (lowering.mode === "realloc-safe") return assignInOrder(lowering, assigned, visit);
  return assignHoisted(lowering, assigned, visit);
}

/**
 * A prefix or postfix update of the field of a use. Analysis never reports one on a boolean
 * field, whose column holds 1/0: incrementing it in place would store 2 or -1 where the runtime
 * setter stores a boolean.
 *
 * @param lowering - The loop's lowering.
 * @param node - The update.
 * @param use - The field-update use.
 * @returns The lowered update.
 * @throws Error when the field is boolean, the operand is no field access, or the loop's shape
 *   has no such field.
 */
export function lowerUpdate(
  lowering: Lowering,
  node: PrefixUnaryExpression | PostfixUnaryExpression,
  use: ViewUse,
): Expression {
  if (lowering.field(use).kind === "boolean") {
    throw new Error(
      `emit: the field update of ${use.comp}.${use.field} targets a boolean field, which has no increment or decrement lowering`,
    );
  }
  lowering.note("update-field");
  const slot = slotOf(node.operand, use);
  lowering.noteNonNull(slot);
  const element = lowering.atRow(lowering.guardedColumn(use, slot));
  if (isPrefixUnaryExpression(node)) return createPrefixUnaryExpression(node.operator, element);
  return createPostfixUnaryExpression(element, node.operator);
}

/**
 * An assignment in hoisted mode, whose column never moves while the loop runs.
 *
 * @param lowering - The loop's lowering.
 * @param assigned - The assignment, its use and slot, its field kind, and whether its value is
 *   used.
 * @param visit - Visits the right-hand side.
 * @returns The lowered assignment.
 */
function assignHoisted(lowering: Lowering, assigned: Assigned, visit: Visit): Expression {
  const { node, use, slot, boolean, valueUsed } = assigned;
  const operator = node.operatorToken.kind;
  const target = (): Expression => lowering.atRow(lowering.guardedColumn(use, slot));
  const value = visitNode(node.right, visit, isExpression);
  if (!boolean) return binary(target(), operator, value);
  const current = decode(target());
  // A decoded boolean is never nullish, so the right-hand side never runs.
  if (operator === SyntaxKind.QuestionQuestionEqualsToken) return current;
  let store: Expression;
  if (valueUsed) {
    const held = lowering.temp("value");
    const encoded = encode(parenthesized(assignTo(createIdentifier(held), value)));
    store = commaList(assignTo(target(), encoded), createIdentifier(held));
  } else {
    store = assignTo(target(), encode(parenthesized(value)));
  }
  const short = logicalOperator(operator);
  if (short === undefined) return store;
  return parenthesized(binary(current, short, parenthesized(store)));
}

/**
 * An assignment in realloc-safe mode, in the order the field accessors see it: the slot's
 * presence, tested once; the current value, for a compound or logical form; the right-hand side;
 * and then the store, which reads the column from the record only when it runs, as the setter
 * reads the column holder's current array. A right-hand side that grows the storage therefore
 * stores into the column growth put in place. The read and the store share the one presence the
 * slot had when the assignment began, as the runtime evaluates `e.C` once, so a right-hand side
 * that disables the component does not make the store throw.
 *
 * @param lowering - The loop's lowering.
 * @param assigned - The assignment, its use and slot, its field kind, and whether its value is
 *   used.
 * @param visit - Visits the right-hand side.
 * @returns The lowered assignment.
 * @throws Error when the operator is no assignment.
 */
function assignInOrder(lowering: Lowering, assigned: Assigned, visit: Visit): Expression {
  const { node, use, slot, boolean, valueUsed } = assigned;
  const operator = node.operatorToken.kind;
  const { steps, column } = heldColumn(lowering, use, slot);
  const field = (): Expression => lowering.atRow(column());
  // A decoded boolean is never nullish, so the right-hand side never runs.
  if (boolean && operator === SyntaxKind.QuestionQuestionEqualsToken) {
    return commaList(...steps, decode(field()));
  }
  const held = lowering.temp("value");
  const heldName = (): Expression => createIdentifier(held);
  const value = visitNode(node.right, visit, isExpression);
  const apply = arithmeticOperator(operator);
  if (apply !== undefined) {
    const combined = binary(heldName(), apply, parenthesized(value));
    return commaList(
      ...steps,
      assignTo(heldName(), field()),
      assignTo(heldName(), combined),
      assignTo(field(), heldName()),
    );
  }
  const hold = assignTo(heldName(), value);
  const write = assignTo(field(), boolean ? encode(heldName()) : heldName());
  const yieldsHeld = boolean && valueUsed;
  const store = (...before: Expression[]): Expression =>
    yieldsHeld ? commaList(...before, hold, write, heldName()) : commaList(...before, hold, write);
  if (operator === SyntaxKind.EqualsToken) return store(...steps);
  const short = logicalOperator(operator);
  if (short === undefined) {
    throw new Error(
      `emit: the field assignment of ${use.comp}.${use.field} has no lowering for operator kind ${operator}`,
    );
  }
  const current = boolean ? decode(field()) : parenthesized(assignTo(heldName(), field()));
  return commaList(...steps, binary(current, short, store()));
}

/**
 * The column a realloc-safe assignment stores into, guarded by the presence its slot had when
 * the assignment began.
 *
 * @param lowering - The loop's lowering.
 * @param use - The field-assign use.
 * @param slot - The slot expression of the use.
 * @returns The steps that test an optional slot's presence once into a temp, and a builder of
 *   the field's column guarded by that presence: `(present ? column : undefined)`, which throws a
 *   TypeError when indexed while the slot was disabled. A required component and an alias, whose
 *   declaration holds the presence it tested, need no step.
 */
function heldColumn(
  lowering: Lowering,
  use: ViewUse,
  slot: Expression,
): { steps: Expression[]; column: () => Expression } {
  if (!lowering.isOptional(use.comp) || use.alias) {
    return { steps: [], column: () => lowering.guardedColumn(use, slot) };
  }
  const present = lowering.temp("present");
  return {
    steps: [assignTo(createIdentifier(present), lowering.present(use, slot))],
    column: () => orUndefined(createIdentifier(present), lowering.columnArray(use)),
  };
}
