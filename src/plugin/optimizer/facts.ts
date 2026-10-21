/**
 * The facts analysis reports about each ecstatic call site of a source file, and the reason catalog
 * that explains why a call keeps its runtime form. Nothing here touches the compiler: a node is
 * named only by its {@link NodeID}.
 */

/**
 * An AST node the analysis reported. IDs are dense from 0 and stable for one source file in one
 * run; the node table maps them back to nodes.
 */
export type NodeID = number;

/**
 * Where a call sits relative to the statement holding it, which decides whether its value can be
 * dropped. `other-expression` is a call whose value is used.
 */
export type StmtContext = "expression-statement" | "arrow-body" | "other-expression";

// ---------------------------------------------------------------------------
// Ops
// ---------------------------------------------------------------------------

/** The public ecstatic functions, one per function the runtime's index exports, in declaration order. */
export const OPS = [
  "each",
  "query",
  "querySources",
  "has",
  "hasAny",
  "enable",
  "disable",
  "get",
  "set",
  "alive",
  "enableMany",
  "disableMany",
  "spawn",
  "spawnMany",
  "despawn",
  "despawnMany",
  "getTarget",
  "link",
  "unlink",
  "getResource",
  "setResource",
  "resetResource",
  "getSources",
  "hasSources",
  "countSources",
  "register",
  "createWorld",
  "destroyWorld",
  "getStorage",
  // `archetype` is the function form, `Archetype` the class-producing form.
  "archetype",
  "Archetype",
  "component",
  "components",
  "relation",
  "resource",
  "ref",
  "f32",
  "f64",
  "i8",
  "i16",
  "i32",
  "u8",
  "u16",
  "u32",
] as const;

/** A public ecstatic function a call site invokes, named as the runtime declares it. */
export type Op = (typeof OPS)[number];

const OP_NAMES: ReadonlySet<string> = new Set(OPS);

function isOp(name: string): name is Op {
  return OP_NAMES.has(name);
}

/**
 * Finds the op whose runtime function is declared as `name`. Names are case-sensitive: `archetype`
 * and `Archetype` are distinct ops.
 *
 * @param name - Function name to look up.
 * @returns The op, or `undefined` when no op has that name.
 */
export function opByName(name: string): Op | undefined {
  return isOp(name) ? name : undefined;
}

/**
 * Whether `op` is an iteration op the optimizer compiles into an inline loop. `querySources` also
 * runs a callback once per entity, but it stays a runtime call, so it does not iterate.
 *
 * @param op - Op to classify.
 * @returns `true` for `each` and `query`.
 */
export function iterates(op: Op): boolean {
  return op === "each" || op === "query";
}

/**
 * The argument counts the runtime's overloads of each iteration op accept. Only iteration ops carry
 * overload data.
 */
const ITERATION_ARG_COUNTS: Readonly<Partial<Record<Op, readonly number[]>>> = {
  each: [2, 3],
  query: [3],
};

/**
 * Whether `count` arguments match one of the op's declared overloads. Only `each` and `query`
 * carry overload data; every other op matches no count.
 *
 * @param op - Op whose overloads are matched.
 * @param count - Number of arguments a call passes.
 * @returns `true` when an overload of `op` accepts `count` arguments.
 */
export function matchesArgCount(op: Op, count: number): boolean {
  return ITERATION_ARG_COUNTS[op]?.includes(count) ?? false;
}

// ---------------------------------------------------------------------------
// Call-site facts
// ---------------------------------------------------------------------------

/** Locates a call in its source file for diagnostics. */
export interface Position {
  readonly file: string;
  /** 0-based position of the call's first token in the file text, in the compiler's own unit. */
  readonly offset: number;
  /** 1-based. */
  readonly line: number;
  /** 1-based. */
  readonly column: number;
}

/** One recognized ecstatic call. */
export interface Site {
  /**
   * Summary of the inline function an `each` or `query` call passes as its last argument;
   * `undefined` when that argument is not an arrow function or function expression, and for every
   * other op.
   */
  readonly callback: Callback | undefined;
  /** Why the call keeps its runtime call, in recorded order; empty while still a candidate. */
  readonly reasons: readonly Reason[];
  /** The ecstatic sites inside this call's callback, in source order. */
  readonly nested: readonly Site[];
  /** One shape for a single storage, one per element for an array literal of storages. */
  readonly shapes: readonly ArchShape[];
  /**
   * The declaration files shape resolution consulted, sorted and without duplicates; the build
   * reports them as dependencies. Add to it with {@link addDeclarationFile}.
   */
  readonly declarationFiles: string[];
  /**
   * The ecstatic package root whose runtime declares the called function, in the file system's own
   * spelling: the `src/ecstatic/debug.ts` a rewrite copies `DEBUG` from is under it.
   */
  readonly root: string;
  readonly pos: Position;
  readonly call: NodeID;
  readonly op: Op;
  readonly context: StmtContext;
  /** Set for an `each` call that passes a filter argument. */
  readonly filtered: boolean;
  /** Set for an `each` call whose storages argument is an array literal, whatever its length. */
  readonly arrayLiteral: boolean;
}

/**
 * Adds a declaration file to a site, keeping its list sorted and free of duplicates.
 *
 * @param site - Site whose `declarationFiles` grows.
 * @param file - Declaration file shape resolution consulted.
 */
export function addDeclarationFile(site: Site, file: string): void {
  if (site.declarationFiles.includes(file)) return;
  site.declarationFiles.push(file);
  site.declarationFiles.sort();
}

/**
 * The syntactic form of a callback's first parameter. `other` is an identifier or pattern with a
 * default, a rest parameter, or an array pattern.
 */
export type ParamForm = "none" | "identifier" | "object-pattern" | "other";

/** The syntactic summary of the inline function an iteration call passes as its last argument. */
export interface Callback {
  /**
   * In source order, every use of a binding the function expression itself provides: `this`,
   * `arguments`, `new.target`, and each reference to its own name. Always empty for an arrow
   * function, whose `this` and `arguments` belong to the enclosing scope.
   */
  readonly functionLocal: readonly NodeID[];
  /** In source order, the references to the view parameter, and to its slot aliases, that lower. */
  readonly viewUses: readonly ViewUse[];
  /**
   * In source order, the references to the view parameter, and to its slot aliases, that do not
   * lower, and the direct `eval` calls. The call keeps its runtime form while any is listed, bar
   * the `nested-loop` ones whose loops plan finds inlined.
   */
  readonly escapes: readonly ViewEscape[];
  /** In source order, the callback's own return statements, not those of nested functions. */
  readonly returns: readonly Return[];
  /**
   * In source order, the declarations of every `var` statement or `for` head that belongs to the
   * callback, not to a nested function or a class static block.
   */
  readonly varDecls: readonly NodeID[];
  /**
   * In source order, the `varDecls` that declare a name the first parameter's object pattern binds:
   * such a `var` starts with the parameter's value, which a fresh per-row binding would lose.
   */
  readonly paramRedeclarations: readonly NodeID[];
  /** In source order, the direct `eval` calls anywhere in the callback, nested functions included. */
  readonly directEval: readonly NodeID[];
  /**
   * In source order, every node the callback evaluates that lies outside the allowlist of nodes
   * unable to run user code that grows a storage.
   */
  readonly hazards: readonly NodeID[];
  /** Declared parameters; a TypeScript `this` parameter is a type annotation and is not counted. */
  readonly params: number;
  readonly firstParam: ParamForm;
  readonly arrow: boolean;
  readonly async: boolean;
  readonly generator: boolean;
  /** Only an arrow function has one; a function expression's body is always a block. */
  readonly exprBody: boolean;
}

/**
 * The role of a reference to a callback's view parameter:
 *
 * - `id` reads `e.id`.
 * - `field-read` reads a field, `e.C.f`.
 * - `field-assign` assigns a field with `=`, a compound operator, `&&=`, `||=`, or `??=`.
 * - `field-update` increments or decrements a field, prefix or postfix.
 * - `optional-read` reads a field through an optional chain that ends at the field, `e.C?.f`.
 * - `presence` tests a slot in a test position: a condition, the operand of `!`, or an operand of
 *   `&&` or `||` that is itself in one.
 * - `compare` compares a slot with `undefined` or `null`.
 * - `coalesce` is `e.C ?? x` in a test position.
 * - `tag` reads a tag slot's value, `true` or `undefined`.
 * - `alias` declares `const p = e.C` or `const p = e.C!` for a data slot, or binds `p` to the data
 *   slot `C` in a pattern destructuring the view; every reference to `p` is a use with `alias` set.
 * - `destructure` destructures the view, when `comp` is empty, or the data slot `comp`, with an
 *   object pattern every property of which lowers: in the callback's parameter, in a `const` or
 *   `let` declaration, or nested in a pattern of the view. Each property is a use of its own, in
 *   pattern order.
 */
export type UseKind =
  | "id"
  | "field-read"
  | "field-assign"
  | "field-update"
  | "optional-read"
  | "presence"
  | "compare"
  | "coalesce"
  | "tag"
  | "alias"
  | "destructure";

/** An operand of a binary expression. */
export type Operand = "left" | "right";

/** One reference to a callback's view parameter, or to an alias of one of its slots. */
export interface ViewUse {
  /** The component of every use but `id`. */
  readonly comp: string;
  /** The field of a field use; empty for every other kind. */
  readonly field: string;
  /**
   * The outermost expression the use spans. Inside a pattern it is the binding element of the
   * property; a `destructure` spans the variable declaration of a `const` or `let`, and otherwise
   * the pattern itself.
   */
  readonly node: NodeID;
  readonly kind: UseKind;
  /** Set when the use reaches the slot through an alias, `p.f` rather than `e.C.f`. */
  readonly alias: boolean;
  /** The operand of a `compare` use's comparison that is the slot; absent for every other kind. */
  readonly slotOperand?: Operand;
}

/**
 * The role of a reference to the view that does not lower:
 *
 * - `view` uses the view itself as a value: passed, stored, compared, or returned.
 * - `computed` reads the view or a slot with a computed key, in an access or a pattern.
 * - `slot-value` uses a data slot, or an alias of one, as a value outside a field, test, or
 *   comparison position.
 * - `key` names a key that is neither `id`, a component of the shape, nor a data field of the
 *   component.
 * - `slot-assign` assigns or updates a slot or `id`.
 * - `chain` continues an optional chain past the field, `e.C?.f.g`.
 * - `nested` references the view, or an alias, inside a nested function.
 * - `nested-loop` references the view, or an alias, inside the inline callback of a nested
 *   iteration call, which only loop composition can lower.
 * - `target` writes a field as a destructuring-assignment or `for…of` target, or deletes it.
 * - `destructure` destructures the view or a slot in a form that does not lower: a rest element, a
 *   default on a slot, `id`, or a tag, an array pattern, a `var` declaration, or an assignment.
 * - `field-call` calls a field as a method, which runs with the field record as `this`.
 * - `boolean-arithmetic` applies an arithmetic compound operator or an update to a boolean field.
 * - `eval` is a direct `eval` call anywhere in the callback, nested functions included: the
 *   evaluated code can reach the view.
 */
export type EscapeKind =
  | "view"
  | "computed"
  | "slot-value"
  | "key"
  | "slot-assign"
  | "chain"
  | "nested"
  | "nested-loop"
  | "target"
  | "destructure"
  | "field-call"
  | "boolean-arithmetic"
  | "eval";

interface EscapeBase {
  /** Locates the first token of `node`. */
  readonly pos: Position;
  /** The view or alias identifier, the access that reads the slot, key, or field, or the `eval` call. */
  readonly node: NodeID;
}

/** A reference from the inline callback of a nested iteration call. */
interface NestedLoopEscape extends EscapeBase {
  readonly kind: "nested-loop";
  /**
   * The call of the innermost nested iteration call whose inline callback holds the reference. The
   * reference lowers only if that call and every iteration call enclosing it within the callback
   * are inlined.
   */
  readonly loop: NodeID;
}

/** A reference that does not lower whatever the nested calls become. */
interface DirectEscape extends EscapeBase {
  readonly kind: Exclude<EscapeKind, "nested-loop">;
}

/** One reference to the view, or to an alias of one of its slots, that does not lower. */
export type ViewEscape = NestedLoopEscape | DirectEscape;

export interface Return {
  readonly node: NodeID;
  /** Set when an iteration statement or a switch lies between the return and the callback's body. */
  readonly nested: boolean;
}

// ---------------------------------------------------------------------------
// Shapes and shape keys
// ---------------------------------------------------------------------------

/**
 * The column kind a component field is stored in: `boolean` as 1/0 in a numeric column, `number` in
 * a numeric column, `plain` in a plain array.
 */
export type FieldKind = "boolean" | "number" | "plain";

export interface Field {
  readonly name: string;
  readonly kind: FieldKind;
}

export interface Component {
  readonly name: string;
  /**
   * In declaration order. The runtime sorts its own copy by code unit, so code that walks columns by
   * position must sort first.
   */
  readonly fields: readonly Field[];
  /** Marks a relation component; its `fields` exclude `target`. */
  readonly relation: boolean;
}

/** An archetype descriptor's component lists, each in declaration order. */
export interface ArchShape {
  readonly required: readonly Component[];
  /** `optional[k]` has presence bit `1 << k`. */
  readonly optional: readonly Component[];
}

/**
 * Returns the first field, in declaration order, whose name equals `name` exactly.
 *
 * @param component - Component whose fields are searched.
 * @param name - Field name.
 * @returns The field, or `undefined` when the component has none of that name.
 */
export function componentField(component: Component, name: string): Field | undefined {
  return component.fields.find((field) => field.name === name);
}

/**
 * Finds a required or optional component of a shape by name.
 *
 * @param shape - Shape whose components are searched.
 * @param name - Component name.
 * @returns The component, or `undefined` when the shape has none of that name.
 */
export function shapeComponent(shape: ArchShape, name: string): Component | undefined {
  return [...shape.required, ...shape.optional].find((component) => component.name === name);
}

const FIELD_KIND_CODES: { readonly [K in FieldKind]: string } = {
  boolean: "b",
  number: "n",
  plain: "p",
};

/**
 * Orders two strings by UTF-16 code unit, as JavaScript's default sort does.
 *
 * @param a - First string.
 * @param b - Second string.
 * @returns A negative number when `a` sorts first, otherwise 1 or 0.
 */
export function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : Number(a > b);
}

/**
 * Keys one component with its fields sorted by name, whatever their declaration order.
 *
 * @param component - Component to key; its fields are left in declaration order.
 * @returns `c` (or `r` for a relation), the length-prefixed name, then `{…}` holding each field as
 *   `<length>:<name>=<kind>`, the fields sorted by name.
 */
function componentKey(component: Component): string {
  const fields = component.fields
    .toSorted((x, y) => compareCodeUnits(x.name, y.name))
    .map((field) => `${field.name.length}:${field.name}=${FIELD_KIND_CODES[field.kind]}`);
  const marker = component.relation ? "r" : "c";
  return `${marker}${component.name.length}:${component.name}{${fields.join(",")}}`;
}

/**
 * The key the runtime shape guard compares a storage's archetype against. The runtime guard
 * computes the same string, so the format is a contract between the two:
 *
 * ```text
 * key       = components(required) "|" components(optional)
 * component = ("c" | "r") len ":" name "{" [field ("," field)*] "}"
 * field     = len ":" name "=" ("b" | "n" | "p")
 * ```
 *
 * `r` marks a relation. Fields are sorted by name in UTF-16 code unit order, and each `len` counts
 * UTF-16 code units, as `.length` does. The length prefix keeps a name holding a separator
 * (`component("A,B")`) from reading as two components.
 *
 * @param shape - Shape to key.
 * @returns The shape key.
 */
export function shapeKey(shape: ArchShape): string {
  const required = shape.required.map(componentKey).join("");
  const optional = shape.optional.map(componentKey).join("");
  return `${required}|${optional}`;
}

// ---------------------------------------------------------------------------
// Reason catalog
// ---------------------------------------------------------------------------

/**
 * When a reason is reported. `silent` marks a call the optimizer leaves alone by design and is never
 * reported. `strict` marks an eligible call that could not be proven: an error under strict, nothing
 * otherwise. `warning` marks a contract violation reported in every build: an error under strict, a
 * warning otherwise.
 */
export type Category = "silent" | "strict" | "warning";

/** Why a call site keeps its runtime call, in catalog order. */
export const REASONS = [
  "SHAPE_UNRESOLVED",
  "STORAGES_DYNAMIC",
  "CALLBACK_NOT_INLINE",
  "CALLBACK_PARAMS",
  "CALLBACK_ASYNC",
  "CALLBACK_GENERATOR",
  "CALLBACK_FUNCTION_BINDINGS",
  "VIEW_ESCAPES",
  "UNSUPPORTED_ASSIGNMENT",
  "INTERNAL",
  "ARG_COUNT",
  "NOT_STATEMENT",
  "OP_NOT_REWRITTEN",
] as const;

/** Why a call site keeps its runtime call. */
export type Reason = (typeof REASONS)[number];

export interface ReasonInfo {
  readonly id: Reason;
  /** Fills the parenthesis of the diagnostic message. */
  readonly text: string;
  /** Follows the message; absent when the reason has none. */
  readonly hint?: string;
  /** The diagnostic code; absent for a silent reason, which is never reported. */
  readonly code?: number;
  readonly category: Category;
}

/** Where the diagnostic writer substitutes a bail's detail in the text of a reason. */
export const DETAIL_PLACEHOLDER = "<detail>";

// Codes are never reused: a reason that leaves the catalog leaves its code retired.
const REASON_CATALOG: { readonly [R in Reason]: Omit<ReasonInfo, "id"> } = {
  SHAPE_UNRESOLVED: {
    code: 99_910,
    category: "strict",
    text: "the storage's archetype shape is not known statically",
    hint: "Type the storage as `Storage<typeof X>` or `Storage<X>`.",
  },
  STORAGES_DYNAMIC: {
    code: 99_912,
    category: "strict",
    text: "the storages argument is not an array literal of typed storages",
  },
  CALLBACK_NOT_INLINE: {
    code: 99_913,
    category: "strict",
    text: "the callback is not written inline",
    hint: "Write `(e) => { ... }` at the call site.",
  },
  CALLBACK_PARAMS: {
    code: 99_914,
    category: "strict",
    text:
      "the callback has a defaulted, rest, or array-pattern parameter, more than one parameter, " +
      "or a `var` redeclaring a destructured parameter",
    hint: "Use `(e)` or an object pattern.",
  },
  CALLBACK_ASYNC: {
    code: 99_915,
    category: "warning",
    text: "the callback is async",
    hint: "Views are valid only until the callback returns; collect ids and await between passes.",
  },
  CALLBACK_GENERATOR: {
    code: 99_916,
    category: "strict",
    text: "the callback is a generator function",
  },
  CALLBACK_FUNCTION_BINDINGS: {
    code: 99_917,
    category: "strict",
    text: "the callback uses `this`, `arguments`, `new.target`, or its own name",
    hint: "Use an arrow function.",
  },
  VIEW_ESCAPES: {
    code: 99_918,
    category: "strict",
    text: `the view \`e\` is used as a value (\`${DETAIL_PLACEHOLDER}\`)`,
    hint: "Read fields on `e`, or keep `e.id`.",
  },
  UNSUPPORTED_ASSIGNMENT: {
    code: 99_919,
    category: "strict",
    text: "a field is the target of a destructuring assignment or a `for…of` head",
  },
  INTERNAL: {
    code: 99_920,
    category: "strict",
    text: `internal error (\`${DETAIL_PLACEHOLDER}\`); please report it`,
  },
  ARG_COUNT: {
    category: "silent",
    text: "argument count matches no rewritable overload",
  },
  NOT_STATEMENT: {
    category: "silent",
    text: "the call's value is used",
  },
  OP_NOT_REWRITTEN: {
    category: "silent",
    text: "the call form has no rewrite in this version",
  },
};

/**
 * The catalog row of a reason, built anew on each call.
 *
 * @param reason - Reason to describe.
 * @returns The catalog entry for `reason`, with its `id` set to `reason`.
 */
export function reasonInfo(reason: Reason): ReasonInfo {
  return { id: reason, ...REASON_CATALOG[reason] };
}
