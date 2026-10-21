import {
  type BindingElement,
  type ElementAccessExpression,
  type Expression,
  type Identifier,
  type Node,
  NodeFlags,
  type ObjectBindingPattern,
  type PropertyAccessExpression,
  SyntaxKind,
} from "typescript/ast";
import {
  isBinaryExpression,
  isBindingElement,
  isDeleteExpression,
  isElementAccessExpression,
  isFunctionLikeDeclaration,
  isIdentifier,
  isObjectBindingPattern,
  isPropertyAccessExpression,
  isVariableDeclaration,
} from "typescript/ast/is";
import { hasExpression } from "typescript/ast/utils";

import type { CheckerSymbol } from "../compiler.js";
import {
  type ArchShape,
  type Component,
  componentField,
  type EscapeKind,
  shapeComponent,
  type UseKind,
} from "../facts.js";
import {
  arithmeticOperator,
  type InlineCallback,
  outermostParens,
  outermostWrapper,
  skipWrappers,
} from "../syntax.js";
import { isInstanceInitializer } from "./evaluated.js";
import {
  blockScope,
  destructuredPattern,
  isAssignmentTo,
  isBinary,
  isCallee,
  isDestructured,
  isNamePosition,
  isPatternTarget,
  isTestPosition,
  isUpdateOf,
  isWriteTarget,
  literalElementKey,
  patternKey,
} from "./roles.js";

const ID_KEY = "id";

/** A view use found in a callback, before its node is registered. */
export interface FoundUse {
  readonly node: Node;
  readonly kind: UseKind;
  readonly comp: string;
  readonly field: string;
  readonly alias: boolean;
}

/** A view escape found in a callback, before its nodes are registered. */
export type FoundEscape =
  | { readonly node: Node; readonly kind: Exclude<EscapeKind, "nested-loop"> }
  | {
      readonly node: Node;
      readonly kind: "nested-loop";
      /** The nested iteration call the escape is recorded against. */
      readonly loop: Node;
    };

/** What classifying a callback's view references reads, every checker answer resolved ahead. */
export interface ViewContext {
  readonly fn: InlineCallback;
  /** The site's resolved shapes; with none, every key reads as a data slot holding any field. */
  readonly shapes: readonly ArchShape[];
  /** The symbol of the identifier first parameter; undefined for any other form. */
  readonly view: CheckerSymbol | undefined;
  /** The object pattern of the first parameter, which destructures the view in place of a symbol. */
  readonly pattern: ObjectBindingPattern | undefined;
  /** The symbol of each identifier that can refer to the view or to an alias of one of its slots. */
  readonly symbols: ReadonlyMap<Node, CheckerSymbol | undefined>;
  /** The callback's declarations that can alias a slot, by the symbol they declare. */
  readonly declarations: ReadonlyMap<CheckerSymbol, Node>;
  /** The identifiers that read the global `undefined`. */
  readonly globalUndefined: ReadonlySet<Node>;
}

/** What every shape of a site holds under one view key. */
interface SlotInfo {
  /** The key's component in each shape; empty when no shape resolved. */
  readonly comps: readonly Component[];
  readonly tag: boolean;
}

/** How a use reaches its slot: through an alias or not, and the field it reads. */
interface UseDetail {
  readonly alias?: boolean;
  readonly field?: string;
}

/** A data slot or tag of the view, by its key. */
interface SlotRef {
  readonly comp: string;
  readonly info: SlotInfo;
}

/** What a reference reads: the view, a slot through an alias, or neither. */
interface Referent {
  readonly view: boolean;
  readonly alias: SlotRef | undefined;
}

const NO_REFERENT: Referent = { view: false, alias: undefined };

/**
 * Classifies the references a callback makes to its view, and to aliases of the view's slots,
 * against the site's shapes: each is a use that lowers or an escape that does not. Uses are kept in
 * the order they are classified; escapes in that order too, for the caller to sort by position.
 */
export class ViewClassifier {
  readonly uses: FoundUse[] = [];
  readonly escapes: FoundEscape[] = [];
  readonly #context: ViewContext;
  readonly #aliases = new Map<CheckerSymbol, SlotRef | undefined>();

  /**
   * Creates a classifier for one callback's view references.
   *
   * @param context - The callback, the site's shapes, and the resolved symbols to classify against.
   */
  constructor(context: ViewContext) {
    this.#context = context;
  }

  /** Classifies the properties of the first parameter's object pattern, when it has one. */
  classifyParamPattern(): void {
    if (this.#context.pattern !== undefined)
      this.#classifyPattern(this.#context.pattern, undefined);
  }

  /**
   * Records the use or escape of an identifier the callback evaluates, when it reads the view or
   * an alias.
   *
   * @param id - The identifier.
   */
  reference(id: Identifier): void {
    const ref = this.#referent(id);
    if (ref.view) this.#classifyView(id);
    else if (ref.alias !== undefined) this.#classifySlot(id, ref.alias, true);
  }

  /**
   * Records an identifier inside code that runs only when called as an escape, when it reads the
   * view or an alias.
   *
   * @param id - The identifier.
   * @param loop - The innermost iteration call whose inline callback holds `id`; undefined when a
   *   function that is no such callback holds it.
   */
  nestedReference(id: Identifier, loop: Node | undefined): void {
    const ref = this.#referent(id);
    if (!ref.view && ref.alias === undefined) return;
    if (loop === undefined) this.escape(id, "nested");
    else this.escapes.push({ node: id, kind: "nested-loop", loop });
  }

  /**
   * Records an escape.
   *
   * @param node - The node that does not lower.
   * @param kind - Why it does not.
   */
  escape(node: Node, kind: Exclude<EscapeKind, "nested-loop">): void {
    this.escapes.push({ node, kind });
  }

  #use(node: Node, kind: UseKind, slot: SlotRef | undefined, how: UseDetail = {}): void {
    const { alias = false, field = "" } = how;
    this.uses.push({ node, kind, comp: slot?.comp ?? "", field, alias });
  }

  #referent(id: Identifier): Referent {
    const { view, pattern, symbols } = this.#context;
    if ((view === undefined && pattern === undefined) || isNamePosition(id)) return NO_REFERENT;
    const symbol = symbols.get(id);
    if (symbol === undefined) return NO_REFERENT;
    if (symbol === view) return { view: true, alias: undefined };
    return { view: false, alias: this.#aliasOf(symbol) };
  }

  #aliasOf(symbol: CheckerSymbol): SlotRef | undefined {
    if (this.#aliases.has(symbol)) return this.#aliases.get(symbol);
    const decl = this.#context.declarations.get(symbol);
    const slot = decl === undefined ? undefined : this.#aliasSlot(decl);
    this.#aliases.set(symbol, slot);
    return slot;
  }

  /**
   * The slot a declaration aliases: `const p = e.C` or `const p = e.C!` for a data slot `C`, `e.C`
   * spelled as `#viewKey` reads it, or the property `C: p` or `C` of a pattern destructuring the
   * view, declared by the callback's own code rather than by a nested function.
   *
   * @param decl - The declaration of the symbol a reference reads.
   * @returns The aliased slot, or undefined when `decl` aliases none.
   */
  #aliasSlot(decl: Node): SlotRef | undefined {
    if (isBindingElement(decl)) return this.#patternSlot(decl);
    const initializer = constIdentifierInitializer(decl);
    if (initializer === undefined) return undefined;
    const slot = this.#dataKeySlot(this.#viewKey(skipWrappers(initializer)));
    return slot === undefined || slot.info.tag || this.#inNestedCode(decl) ? undefined : slot;
  }

  /**
   * What the shapes hold under a key, unless it is absent or `id`, which is no component.
   *
   * @param key - The view key, when there is one.
   * @returns The slot, or undefined when `key` is absent, `id`, or names no slot.
   */
  #dataKeySlot(key: string | undefined): SlotRef | undefined {
    return key === undefined || key === ID_KEY ? undefined : this.#slot(key);
  }

  /**
   * The key an access reads from the view: `e.K`, or `e["C"]` whose string literal names a
   * component of the shape, the only way to reach a component whose name is no identifier.
   *
   * @param access - The expression to read.
   * @returns The key, or undefined for an optional access and any other expression.
   */
  #viewKey(access: Node): string | undefined {
    if (!isPropertyAccessExpression(access) && !isElementAccessExpression(access)) return undefined;
    if (access.questionDotToken !== undefined || !this.#isView(skipWrappers(access.expression))) {
      return undefined;
    }
    if (isPropertyAccessExpression(access)) return access.name.text;
    const key = literalElementKey(access);
    return key === undefined || key === ID_KEY || this.#slot(key) === undefined ? undefined : key;
  }

  /**
   * The data slot a property, with no default, of a pattern destructuring the view binds.
   *
   * @param element - The pattern property.
   * @returns The slot, or undefined when `element` binds none.
   */
  #patternSlot(element: BindingElement): SlotRef | undefined {
    if (
      element.dotDotDotToken !== undefined ||
      element.initializer !== undefined ||
      element.name === undefined ||
      !isIdentifier(element.name) ||
      !this.#isViewPattern(element.parent)
    ) {
      return undefined;
    }
    const slot = this.#dataKeySlot(patternKey(element));
    return slot?.info.tag === false ? slot : undefined;
  }

  /**
   * Whether a pattern destructures the view: it is the first parameter's pattern, or the pattern of
   * a declaration in the callback's own code that {@link destructuredPattern} lowers, whose value
   * is the view.
   *
   * @param pattern - The binding pattern.
   * @returns Whether `pattern` destructures the view.
   */
  #isViewPattern(pattern: Node): boolean {
    if (pattern === this.#context.pattern) return true;
    const decl = pattern.parent;
    return (
      isVariableDeclaration(decl) &&
      decl.initializer !== undefined &&
      destructuredPattern(decl.initializer) === pattern &&
      this.#isView(skipWrappers(decl.initializer)) &&
      !this.#inNestedCode(decl)
    );
  }

  /**
   * Records an object pattern destructuring the view or a data slot as a use, at its declaration
   * when a `const` or `let` declares it, then each of its properties, in pattern order, as a use or
   * an escape.
   *
   * @param pattern - The pattern.
   * @param owner - The data slot the pattern destructures; undefined for the view.
   */
  #classifyPattern(pattern: ObjectBindingPattern, owner: SlotRef | undefined): void {
    const node = isVariableDeclaration(pattern.parent) ? pattern.parent : pattern;
    this.#use(node, "destructure", owner);
    for (const element of pattern.elements) {
      const key = patternKey(element);
      if (element.dotDotDotToken !== undefined) this.escape(element, "destructure");
      else if (key === undefined) this.escape(element, "computed");
      else if (owner === undefined) this.#classifyPatternSlot(element, key);
      else this.#classifyPatternField(element, owner, key);
    }
  }

  /**
   * Records a property of a pattern destructuring the view.
   *
   * @param element - The pattern property.
   * @param key - The view key the property reads.
   */
  #classifyPatternSlot(element: BindingElement, key: string): void {
    const slot = this.#slot(key);
    const { name } = element;
    if (element.initializer !== undefined) this.escape(element, "destructure");
    else if (key === ID_KEY) this.#use(element, "id", undefined);
    else if (slot === undefined) this.escape(element, "key");
    else if (slot.info.tag) this.#use(element, "tag", slot);
    else if (name !== undefined && isIdentifier(name)) this.#use(element, "alias", slot);
    else if (name !== undefined && isObjectBindingPattern(name)) this.#classifyPattern(name, slot);
    else this.escape(element, "destructure");
  }

  /**
   * Records a property of a pattern destructuring a data slot. Whatever the property binds the
   * field to is plain code on the field's value.
   *
   * @param element - The pattern property.
   * @param owner - The destructured slot.
   * @param key - The field the property reads.
   */
  #classifyPatternField(element: BindingElement, owner: SlotRef, key: string): void {
    const field = fieldOf(owner.info, key);
    if (field === undefined) this.escape(element, "key");
    else this.#use(element, "field-read", owner, { field: field.name });
  }

  /**
   * Records the reference an identifier makes to the view by the expression around it, past any
   * parentheses and non-null assertions: `e.K`, `e[...]`, or the value a pattern destructures. Any
   * other expression, `e?.K` included, is a `view` escape.
   *
   * @param id - The identifier reading the view.
   */
  #classifyView(id: Identifier): void {
    const outer = outermostWrapper(id);
    const up = outer.parent;
    if (isPropertyAccessOn(up, outer) && up.questionDotToken === undefined) {
      this.#classifyKey(up);
    } else if (isElementAccessOn(up, outer)) {
      this.#classifyElement(up);
    } else {
      this.#classifyViewValue(id, outer);
    }
  }

  /**
   * Records the reference `e[...]` makes to the view.
   *
   * @param access - The element access on the view.
   */
  #classifyElement(access: ElementAccessExpression): void {
    const key = this.#viewKey(access);
    const slot = key === undefined ? undefined : this.#slot(key);
    if (slot === undefined) this.escape(access, "computed");
    else this.#classifySlot(access, slot, false);
  }

  /**
   * Records the reference the view makes as a value rather than through an access: the value a
   * pattern destructures, or an escape.
   *
   * @param id - The identifier reading the view.
   * @param outer - `id` with its outermost wrapper.
   */
  #classifyViewValue(id: Identifier, outer: Node): void {
    const pattern = destructuredPattern(outer);
    if (pattern !== undefined) this.#classifyPattern(pattern, undefined);
    else if (isDestructured(outer)) this.escape(outer, "destructure");
    else this.escape(id, "view");
  }

  /**
   * Records the reference `e.K` makes to the view.
   *
   * @param access - The access `e.K`.
   */
  #classifyKey(access: PropertyAccessExpression): void {
    const key = access.name.text;
    const slot = this.#slot(key);
    if (key === ID_KEY && isWriteTarget(access)) this.escape(access, "slot-assign");
    else if (key === ID_KEY) this.#use(access, "id", undefined);
    else if (slot === undefined) this.escape(access, "key");
    else this.#classifySlot(access, slot, false);
  }

  /**
   * Records the reference a node makes to a slot.
   *
   * @param node - `e.C`, or an identifier aliasing it when `alias` is set.
   * @param slot - The slot.
   * @param alias - Whether `node` reaches the slot through an alias.
   */
  #classifySlot(node: Node, slot: SlotRef, alias: boolean): void {
    const outer = outermostWrapper(node);
    const up = outer.parent;
    if (isPropertyAccessOn(up, outer)) this.#classifySlotKey(up, slot, alias);
    else if (isElementAccessOn(up, outer)) this.escape(up, "computed");
    else this.#classifySlotPosition(outer, slot, alias);
  }

  /**
   * Records a slot used as a value rather than accessed: in a test, a nullish comparison, or a
   * `??`, as a write target, as a tag, or as the value of its parent.
   *
   * @param outer - The slot reference with its outermost wrapper.
   * @param slot - The slot.
   * @param alias - Whether `outer` reaches the slot through an alias.
   */
  #classifySlotPosition(outer: Node, slot: SlotRef, alias: boolean): void {
    const test = this.#testUse(outer);
    if (test !== undefined) this.#use(test.node, test.kind, slot, { alias });
    else if (isWriteTarget(outer)) this.escape(outer, "slot-assign");
    else if (slot.info.tag) this.#use(outer, "tag", slot, { alias });
    else if (!alias) this.#classifySlotValue(outer, slot);
    else this.escape(outer, "slot-value");
  }

  /**
   * The use a slot makes when only its presence matters: a test, a comparison with `null` or the
   * global `undefined`, or the left of a `??` whose own value is tested.
   *
   * @param outer - The slot reference with its outermost wrapper.
   * @returns The node the use is recorded at and its kind, or undefined when `outer` is in none.
   */
  #testUse(outer: Node): { readonly node: Node; readonly kind: UseKind } | undefined {
    const up = outer.parent;
    if (isTestPosition(outer)) return { node: outer, kind: "presence" };
    if (this.#isNullishComparison(up)) return { node: up, kind: "compare" };
    if (isBinary(up, SyntaxKind.QuestionQuestionToken) && up.left === outer && isTestPosition(up)) {
      return { node: up, kind: "coalesce" };
    }
    return undefined;
  }

  /**
   * Records `e.C`, a data slot read directly, used as the value of its parent.
   *
   * @param outer - `e.C`, with its outermost wrapper.
   * @param slot - The slot.
   */
  #classifySlotValue(outer: Node, slot: SlotRef): void {
    const up = outer.parent;
    const pattern = destructuredPattern(outer);
    if (
      isVariableDeclaration(up) &&
      up.initializer === outer &&
      this.#aliasSlot(up) !== undefined
    ) {
      this.#use(up, "alias", slot);
    } else if (pattern !== undefined) {
      this.#classifyPattern(pattern, slot);
    } else if (isDestructured(outer)) {
      this.escape(outer, "destructure");
    } else {
      this.escape(outer, "slot-value");
    }
  }

  /**
   * Records the reference `S.f` on a slot `S` makes to the field `f`.
   *
   * @param access - The access `S.f`.
   * @param slot - The slot.
   * @param alias - Whether `S` is an alias of the slot.
   */
  #classifySlotKey(access: PropertyAccessExpression, slot: SlotRef, alias: boolean): void {
    const field = fieldOf(slot.info, access.name.text);
    if (field === undefined) {
      this.escape(access, "key");
      return;
    }
    if (access.questionDotToken === undefined) {
      this.#classifyField(access, field, slot, alias);
      return;
    }
    const parent = access.parent;
    if (
      (parent.flags & NodeFlags.OptionalChain) !== 0 &&
      hasExpression(parent) &&
      parent.expression === access
    ) {
      this.escape(access, "chain");
    } else {
      this.#use(access, "optional-read", slot, { alias, field: field.name });
    }
  }

  /**
   * Records the reference a field `S.f` makes by the position it stands in.
   *
   * @param access - The access `S.f`.
   * @param field - The field.
   * @param slot - The slot.
   * @param alias - Whether `S` is an alias of the slot.
   */
  #classifyField(
    access: PropertyAccessExpression,
    field: FieldInfo,
    slot: SlotRef,
    alias: boolean,
  ): void {
    const outer = outermostParens(access);
    const up = outer.parent;
    if (isPatternTarget(outer) || isDeleteExpression(up)) {
      this.escape(access, "target");
    } else if (isAssignmentTo(up, outer)) {
      if (field.boolean && arithmeticOperator(up.operatorToken.kind) !== undefined) {
        this.escape(access, "boolean-arithmetic");
      } else {
        this.#use(up, "field-assign", slot, { alias, field: field.name });
      }
    } else if (isUpdateOf(up, outer)) {
      if (field.boolean) this.escape(access, "boolean-arithmetic");
      else this.#use(up, "field-update", slot, { alias, field: field.name });
    } else if (isCallee(access)) {
      this.escape(access, "field-call");
    } else {
      this.#use(access, "field-read", slot, { alias, field: field.name });
    }
  }

  /**
   * Whether a node compares an operand with `null` or the global `undefined`, either side.
   *
   * @param node - The node to test.
   * @returns Whether `node` is such a comparison.
   */
  #isNullishComparison(node: Node): boolean {
    if (!isBinaryExpression(node)) return false;
    switch (node.operatorToken.kind) {
      case SyntaxKind.EqualsEqualsEqualsToken:
      case SyntaxKind.ExclamationEqualsEqualsToken:
      case SyntaxKind.EqualsEqualsToken:
      case SyntaxKind.ExclamationEqualsToken:
        return this.#isNullish(node.left) || this.#isNullish(node.right);
      default:
        return false;
    }
  }

  #isNullish(expr: Expression): boolean {
    const inner = skipWrappers(expr);
    return inner.kind === SyntaxKind.NullKeyword || this.#context.globalUndefined.has(inner);
  }

  /**
   * What the shapes hold under a view key.
   *
   * @param comp - The key.
   * @returns The slot, or undefined when some shape holds no component of that name or the shapes
   *   disagree on whether it is a tag.
   */
  #slot(comp: string): SlotRef | undefined {
    const comps: Component[] = [];
    let tag = false;
    for (const [i, shape] of this.#context.shapes.entries()) {
      const component = shapeComponent(shape, comp);
      const isTag = component?.fields.length === 0;
      if (component === undefined || (i > 0 && tag !== isTag)) return undefined;
      tag = isTag;
      comps.push(component);
    }
    return { comp, info: { comps, tag } };
  }

  #isView(node: Node): boolean {
    const { view, symbols } = this.#context;
    return view !== undefined && isIdentifier(node) && symbols.get(node) === view;
  }

  /**
   * Whether a node lies in code that runs only when called: a function nested in the callback, or
   * an instance field's initializer.
   *
   * @param node - A node inside the callback.
   * @returns Whether nested code holds `node`.
   */
  #inNestedCode(node: Node): boolean {
    let child = node;
    for (let parent = node.parent; parent !== this.#context.fn; parent = parent.parent) {
      if (isFunctionLikeDeclaration(parent) || isInstanceInitializer(parent, child)) return true;
      child = parent;
    }
    return false;
  }
}

/**
 * Whether a node is a property access whose object is an operand.
 *
 * @param node - The node to test.
 * @param object - The operand.
 * @returns Whether `node` is `object.name`.
 */
function isPropertyAccessOn(node: Node, object: Node): node is PropertyAccessExpression {
  return isPropertyAccessExpression(node) && node.expression === object;
}

/**
 * Whether a node is an element access whose object is an operand.
 *
 * @param node - The node to test.
 * @param object - The operand.
 * @returns Whether `node` is `object[key]`.
 */
function isElementAccessOn(node: Node, object: Node): node is ElementAccessExpression {
  return isElementAccessExpression(node) && node.expression === object;
}

/**
 * The initializer of a `const` declaration of a single identifier.
 *
 * @param decl - The declaration to test.
 * @returns The initializer, or undefined when `decl` is any other declaration or has none.
 */
function constIdentifierInitializer(decl: Node): Expression | undefined {
  if (!isVariableDeclaration(decl) || !isIdentifier(decl.name)) return undefined;
  return blockScope(decl.parent) === "const" ? decl.initializer : undefined;
}

/** A field of a slot, with whether the first shape's component stores it as a boolean. */
interface FieldInfo {
  readonly name: string;
  readonly boolean: boolean;
}

/**
 * A slot's field. With no shape resolved, every name is a field of unknown kind.
 *
 * @param info - The slot.
 * @param name - The field's name.
 * @returns The field, or undefined when some shape's component lacks it.
 */
function fieldOf(info: SlotInfo, name: string): FieldInfo | undefined {
  let boolean: boolean | undefined;
  for (const comp of info.comps) {
    const field = componentField(comp, name);
    if (field === undefined) return undefined;
    boolean ??= field.kind === "boolean";
  }
  return { name, boolean: boolean ?? false };
}
