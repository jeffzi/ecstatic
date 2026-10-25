/**
 * The rewrite catalog: every rule the fixture corpus must cover. A rule is a mode of the emitted
 * loop, a row of the view lowering table, a destructuring form, or a callback transplant case. A
 * loop applies a rule when building it takes the code path the rule names.
 */

/** The rules of the rewrite catalog, in catalog order, each spelled as a fixture's rewrite claim. */
export const RULES = [
  "mode-hoisted",
  "mode-realloc-safe",

  "entity-id",
  "read-required-field",
  "read-optional-field",
  // Decodes a boolean column's 1/0 as true/false.
  "read-boolean-field",
  "write-required-field",
  "write-optional-field",
  // Encodes the value a boolean field is assigned as 1/0.
  "write-boolean-field",
  // Yields what a boolean field assignment was given, not the encoded number.
  "boolean-assignment-value",
  "update-field",
  // Reads or writes a data field of a relation slot, whose column holds the relation's data beside
  // its target.
  "relation-data-field",
  // Reaches a field through a non-null-asserted slot, `e.C!.f` or an alias `const p = e.C!`.
  "non-null-slot",
  "optional-chain-read",
  // Tests an optional slot's bit, in a test position or compared with undefined or `== null`.
  "presence-optional",
  // Lowers the same tests of a required slot to a constant.
  "presence-required",
  "compare-null-strict-equal",
  "compare-null-strict-not-equal",
  "coalesce-optional",
  "coalesce-required",
  "required-tag",
  "optional-tag",
  // Declares `const p = e.C` or `const p = e.C!`, testing presence once.
  "alias",

  // Declares `const { x, y: py } = e.C` or its `let` form.
  "destructure-slot",
  // Binds slot aliases in the callback's parameter pattern.
  "destructure-parameter",
  // Reads a slot's fields through a pattern nested in the parameter pattern.
  "destructure-parameter-nested",
  "destructure-id",
  // Binds slot aliases in a declaration destructuring the view.
  "destructure-view",
  // Reads a slot's fields through a pattern nested in a declaration of the view.
  "destructure-view-nested",
  // Tests an optional slot once and guards before reading its fields.
  "destructure-optional-slot",
  "destructure-optional-tag",
  // Drops a field default on a typed-array column, which never holds undefined.
  "destructure-default-typed",
  // Applies a field default to undefined on a plain-array column.
  "destructure-default-plain",

  "callback-arrow",
  "callback-function",
  "callback-without-parameter",
  // Ignores the type annotation of the callback's parameter.
  "callback-typed-parameter",
  "return-void",
  // Runs a returned expression as a statement before continuing.
  "return-value",
  // Runs a returned expression that starts with an object literal as a statement, which the
  // printer parenthesizes so it does not read as a block.
  "return-object-literal",
  // Runs a returned expression that starts with a function expression as a statement, which the
  // printer parenthesizes so it does not read as a function declaration.
  "return-function-expression",
  // Runs a returned expression that starts with a class expression as a statement, which the
  // printer parenthesizes so it does not read as a class declaration.
  "return-class-expression",
  // Continues the labeled row loop from a return under an inner loop or switch.
  "return-labeled",
  "return-in-finally",
  // Leaves the returns of a function nested in the body as they are.
  "return-in-nested-function",
  "expression-body",
  // Keeps a reference to a binding outside the callback pointing at it when a name the loop adds
  // has the same base, which then takes a fresh name instead.
  "outer-binding",
  // Keeps a body let, const, class, or function declaration fresh on every row.
  "block-scoped-declaration",
  // Keeps a function created in the body capturing that row's bindings.
  "closure",
  // Keeps in place a read of an outer let, const, or class declared after the call, which throws
  // at the same point as in the callback.
  "outer-let-dead-zone",
  "this",
  "arguments",
  // Keeps an arrow callback's new.target, the enclosing function's.
  "new-target",
  "super",
  // Declares the body's var bindings with let at the top of the row block.
  "var-to-let",
  // Keeps the body's labeled statements, break, and continue as written.
  "user-label",
  // Gives a body label that a statement enclosing the call also declares a fresh name, in its
  // labeled statement and in the break and continue that name it.
  "user-label-renamed",
  "throw",
] as const;

/** One rule of the rewrite catalog. */
export type Rule = (typeof RULES)[number];

/**
 * The applied rules, in catalog order.
 *
 * @param applied - Rules a file's loops applied.
 * @returns Each rule of `applied` once, ordered as {@link RULES} lists it.
 */
export function inCatalogOrder(applied: ReadonlySet<Rule>): Rule[] {
  return RULES.filter((rule) => applied.has(rule));
}
