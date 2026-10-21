/**
 * The lowering of patterns that destructure the view or one of its slots, in a body declaration or
 * the callback's parameter. It mirrors the reads destructuring makes through `buildView`
 * (`src/ecstatic/entity/each.ts`): an optional slot's getter tests presence once, and the record
 * `fieldAccessorsFor` builds then reads each field's column without testing it again.
 */

import {
  type BindingElement,
  type BindingName,
  type Expression,
  type VariableDeclaration,
  SyntaxKind,
} from "typescript/ast";
import { createIdentifier, createObjectBindingPattern } from "typescript/ast/factory";
import {
  isBindingName,
  isExpression,
  isObjectBindingPattern,
  isVariableDeclaration,
} from "typescript/ast/is";
import { visitNode } from "typescript/ast/visitor";

import type { ViewUse } from "../facts.js";
import type { Rule } from "./catalog.js";
import {
  assignTo,
  binary,
  conditional,
  declaration,
  numeric,
  orUndefined,
  parenthesized,
  undefinedValue,
  type Visit,
} from "./expressions.js";
import type { Lowering } from "./lowering.js";

/** Where a pattern destructuring the view stands: a body declaration or the callback's parameter. */
export type PatternSite = "declaration" | "parameter";

/** What a pattern of the view lowers through, and where it stands. */
export interface PatternContext {
  readonly lowering: Lowering;
  readonly site: PatternSite;
  /** Visits the defaults and nested patterns the destructuring evaluates. */
  readonly visit: Visit;
}

/** The rule of a slot alias bound in a pattern of the view, by where the pattern stands. */
const ALIAS_RULES: Readonly<Record<PatternSite, Rule>> = {
  declaration: "destructure-view",
  parameter: "destructure-parameter",
};

/** The rule of a slot pattern nested in a pattern of the view, by where the pattern stands. */
const NESTED_RULES: Readonly<Record<PatternSite, Rule>> = {
  declaration: "destructure-view-nested",
  parameter: "destructure-parameter-nested",
};

/**
 * The declarations that bind, in pattern order, a pattern destructuring the view or a slot.
 *
 * @param context - The lowering, and where the pattern of the view stands.
 * @param node - A `const` or `let` declaration, or the pattern itself.
 * @param use - The destructure use of `node`.
 * @returns The declarations.
 * @throws Error when the pattern is no object pattern, one of its properties has no view use or a
 *   use with no lowering in a pattern, the loop's shape has no field a property reads, or an alias
 *   property binds no name.
 */
export function destructure(
  context: PatternContext,
  node: VariableDeclaration | BindingName,
  use: ViewUse,
): VariableDeclaration[] {
  const { lowering } = context;
  const pattern = isVariableDeclaration(node) ? node.name : node;
  if (isVariableDeclaration(node) && use.comp !== "") lowering.note("destructure-slot");
  if (use.kind !== "destructure" || !isObjectBindingPattern(pattern)) {
    const what = use.comp === "" ? "the view" : use.comp;
    throw new Error(`emit: the destructuring of ${what} has no lowering`);
  }
  const declarations: VariableDeclaration[] = [];
  if (lowering.isOptional(use.comp)) {
    lowering.note("destructure-optional-slot");
    declarations.push(slotGuard(lowering, use));
  }
  for (const element of pattern.elements) declarations.push(...bindElement(context, element));
  return declarations;
}

/**
 * An empty pattern of `(present ? 0 : undefined)` for an optional slot, which throws a TypeError
 * while the slot is disabled, as destructuring the getter's `undefined` does, even when the
 * pattern binds nothing.
 *
 * @param lowering - The loop's lowering.
 * @param use - The destructure use of the slot.
 * @returns The declaration.
 */
function slotGuard(lowering: Lowering, use: ViewUse): VariableDeclaration {
  const empty = createObjectBindingPattern([]);
  return declaration(empty, orUndefined(lowering.present(use, undefined), numeric("0")));
}

/**
 * The declarations binding one property of a pattern that destructures the view or a slot: those
 * of the slot's own pattern, or one declaration of what the property binds, a plain binding or a
 * pattern on a plain value.
 *
 * @param context - The lowering, and where the pattern of the view stands.
 * @param element - The property.
 * @returns The declarations.
 * @throws Error when the property has no view use, or one with no lowering in a pattern.
 */
function bindElement(context: PatternContext, element: BindingElement): VariableDeclaration[] {
  const { lowering, site, visit } = context;
  const { name } = element;
  const nested = name === undefined ? undefined : lowering.useOf(name);
  if (name !== undefined && nested !== undefined) {
    lowering.note(NESTED_RULES[site]);
    return destructure(context, name, nested);
  }
  const use = lowering.useOf(element);
  if (name === undefined || use === undefined) {
    throw new Error("emit: a property of a lowered pattern has no view use");
  }
  if (use.kind === "alias") {
    lowering.note(ALIAS_RULES[site]);
    return [lowering.aliasDeclaration(element, use)];
  }
  const bound = visitNode(name, visit, isBindingName);
  if (use.kind === "field-read") return [declaration(bound, fieldValue(context, element, use))];
  if (use.kind === "id") {
    lowering.note("destructure-id");
    return [declaration(bound, lowering.idValue())];
  }
  if (use.kind === "tag") {
    if (lowering.isOptional(use.comp)) lowering.note("destructure-optional-tag");
    return [declaration(bound, lowering.tagValue(use, undefined))];
  }
  throw new Error(`emit: the view use of ${use.comp}, kind ${use.kind}, has no pattern lowering`);
}

/**
 * The field of a slot pattern's property, applying the property's default as destructuring the
 * record does: never on a typed-array column, which never holds undefined, and on undefined in a
 * plain-array one.
 *
 * @param context - The lowering, and the visitor of the default.
 * @param element - The property.
 * @param use - The field-read use of the property.
 * @returns The column's element, or `(t = column[i]) === undefined ? default : t`.
 */
function fieldValue(context: PatternContext, element: BindingElement, use: ViewUse): Expression {
  const { lowering, visit } = context;
  const read = lowering.read(use, lowering.columnArray(use));
  const fallback = element.initializer;
  if (fallback === undefined) return read;
  if (lowering.field(use).kind !== "plain") {
    lowering.note("destructure-default-typed");
    return read;
  }
  lowering.note("destructure-default-plain");
  const held = lowering.temp("value");
  const unset = binary(
    parenthesized(assignTo(createIdentifier(held), read)),
    SyntaxKind.EqualsEqualsEqualsToken,
    undefinedValue(),
  );
  return conditional(unset, visitNode(fallback, visit, isExpression), createIdentifier(held));
}
