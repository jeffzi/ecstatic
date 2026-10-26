import {
  type Expression,
  type Node,
  type NodeArray,
  SyntaxKind,
  type TypeNode,
} from "typescript/ast";
import {
  isArrayLiteralExpression,
  isIdentifier,
  isParenthesizedTypeNode,
  isPropertySignatureDeclaration,
  isSpreadElement,
  isUnionTypeNode,
} from "typescript/ast/is";

import {
  apparentType,
  baseTypeOfLiteral,
  type Checker,
  type CheckerSymbol,
  declarationFileNames,
  declarationsOf,
  foreignValueFileName,
  isArrayLike,
  nonNullableType,
  propertiesOfType,
  propertyOfType,
  requiredTupleElements,
  type Type,
  typeAtLocation,
  typeOfSymbol,
  typeSymbol,
  unionMembers,
} from "../compiler.js";
import {
  type ArchShape,
  type Component,
  type Field,
  type FieldKind,
  type Reason,
  shapeKey,
} from "../facts.js";
import {
  isAnyOrUnknown,
  isBooleanType,
  isNumberType,
  isSymbolKeyed,
  stringLiteralValue,
  symbolName,
} from "./checker-fields.js";

/** What an `each` call's storages argument says about the archetypes it iterates. */
export interface ShapeResolution {
  /** One shape for a single storage, one per element for an array literal; empty when unresolved. */
  readonly shapes: readonly ArchShape[];
  /** Why the shapes are not known statically; undefined when they resolved. */
  readonly reason: Reason | undefined;
  /** The declaration files resolution consulted, resolved or not, sorted and without duplicates. */
  readonly declarationFiles: readonly string[];
}

/**
 * Reads the archetype shapes of an `each` call's storages argument off its static type: one shape
 * for a storage, one per element for an array literal of storages. A storage whose type does not pin
 * its shape is `SHAPE_UNRESOLVED`; storages that cannot be unrolled are `STORAGES_DYNAMIC`.
 *
 * @param checker - Checker of the program holding `storages`.
 * @param storages - The call's storages argument.
 * @returns The shapes or the reason they did not resolve, with the declaration files consulted.
 * @throws When a consulted declaration's source file is no longer available.
 */
export async function resolveShapes(
  checker: Checker,
  storages: Expression,
): Promise<ShapeResolution> {
  const resolver = new ShapeResolver(checker);
  const shapes = await resolver.argumentShapes(storages);
  const declarationFiles = [...resolver.files].toSorted();
  if (typeof shapes === "string") return { shapes: [], reason: shapes, declarationFiles };
  return { shapes, reason: undefined, declarationFiles };
}

/** What one storage expression's static type says about the archetype it holds. */
export interface StorageShape {
  /** The shape; undefined when the type does not pin one. */
  readonly shape: ArchShape | undefined;
  /** The declaration files resolution consulted, resolved or not, sorted and without duplicates. */
  readonly declarationFiles: readonly string[];
}

/**
 * Reads the archetype shape of a single storage expression off its static type, as the target of
 * a `spawn` names one.
 *
 * @param checker - Checker of the program holding `storage`.
 * @param storage - The storage expression.
 * @returns The shape, or undefined in its place when the type does not pin one, with the
 *   declaration files consulted.
 * @throws When a consulted declaration's source file is no longer available.
 */
export async function resolveStorageShape(
  checker: Checker,
  storage: Expression,
): Promise<StorageShape> {
  const resolver = new ShapeResolver(checker);
  const shape = await resolver.storageShape(storage);
  return { shape, declarationFiles: [...resolver.files].toSorted() };
}

/**
 * The static type of an expression. The checker types a value declared in another file, an
 * imported one, a property of an imported object, or the result of calling an imported function,
 * from that file, so the files declaring `expr` and every identifier under it are consulted.
 *
 * @param checker - Checker of the program holding `expr`.
 * @param expr - The expression to type.
 * @param files - The consulted declaration files, which the files declaring `expr` and the
 *   identifiers under it join.
 * @returns Its static type.
 * @throws When a declaring file is no longer available, or the compiler process has exited.
 */
export async function consultedType(
  checker: Checker,
  expr: Expression,
  files: Set<string>,
): Promise<Type> {
  const [type, ...declaringFiles] = await Promise.all([
    typeAtLocation(checker, expr),
    ...readNames(expr).map(async (name) => await foreignValueFileName(checker, name)),
  ]);
  for (const file of declaringFiles) if (file !== undefined) files.add(file);
  return type;
}

/**
 * The nodes of an expression that read a declared value: the expression itself and every
 * identifier under it, in source order.
 *
 * @param expr - The expression to read.
 * @returns `expr` first, then each identifier below it.
 */
function readNames(expr: Expression): Node[] {
  const names: Node[] = [expr];
  const visit = (node: Node): void => {
    if (isIdentifier(node)) names.push(node);
    node.forEachChild(visit);
  };
  expr.forEachChild(visit);
  return names;
}

/**
 * The component name a descriptor type pins: its `__ecstatic_name`, which must be a single string
 * literal.
 *
 * @param checker - Checker that produced `type`.
 * @param type - A component descriptor type.
 * @param files - The consulted declaration files, which the declarations of `__ecstatic_name` join.
 * @returns The name, or undefined when `type` does not pin one, as a union of names does not.
 * @throws When a declaration's source file is no longer available.
 */
export async function componentName(
  checker: Checker,
  type: Type,
  files: Set<string>,
): Promise<string | undefined> {
  return stringLiteralValue(await consultedProperty(checker, type, "__ecstatic_name", files));
}

/**
 * The type of a property, whose declarations are consulted.
 *
 * @param checker - Checker that produced `type`.
 * @param type - Type holding the property.
 * @param name - Property name.
 * @param files - The consulted declaration files, which the property's declarations join.
 * @returns The property's type, or undefined when `type` has no such property.
 * @throws When a declaration's source file is no longer available.
 */
async function consultedProperty(
  checker: Checker,
  type: Type,
  name: string,
  files: Set<string>,
): Promise<Type | undefined> {
  const symbol = await propertyOfType(checker, type, name);
  if (symbol === undefined) return undefined;
  const [, propertyType] = await Promise.all([
    consultDeclarations(symbol, files),
    typeOfSymbol(checker, symbol),
  ]);
  return propertyType;
}

/**
 * Adds the files declaring a symbol to the consulted declaration files.
 *
 * @param symbol - The symbol; undefined when the type has none, which declares nothing.
 * @param files - The consulted declaration files, which the symbol's declaring files join.
 * @throws When a declaration's source file is no longer available.
 */
export async function consultDeclarations(
  symbol: CheckerSymbol | undefined,
  files: Set<string>,
): Promise<void> {
  for (const file of await declarationFileNames(symbol)) files.add(file);
}

/**
 * Adds the files declaring a type's symbol to the consulted declaration files.
 *
 * @param type - The type; one with no symbol, such as a primitive, declares nothing.
 * @param files - The consulted declaration files, which the files declaring the type's symbol join.
 * @throws When a declaration's source file is no longer available, or the compiler process has
 *   exited.
 */
export async function consultTypeDeclarations(type: Type, files: Set<string>): Promise<void> {
  await consultDeclarations(await typeSymbol(type), files);
}

/**
 * Whether a type annotation is a union with `undefined` among its members.
 *
 * @param type - The annotation; undefined when there is none.
 * @returns Whether `type`, its parentheses skipped, is a union naming `undefined`.
 */
function joinsUndefined(type: TypeNode | undefined): boolean {
  let node = type;
  while (node !== undefined && isParenthesizedTypeNode(node)) node = node.type;
  return (
    node !== undefined &&
    isUnionTypeNode(node) &&
    node.types.some((member) => member.kind === SyntaxKind.UndefinedKeyword)
  );
}

/**
 * The column kind a field's value type is stored in: boolean and number get numeric columns,
 * anything else, `undefined`-including unions among them, a plain array.
 *
 * @param checker - Checker that produced `type`.
 * @param type - The field's value type.
 * @returns The field's column kind.
 */
async function fieldKind(checker: Checker, type: Type): Promise<FieldKind> {
  const base = await baseTypeOfLiteral(checker, type);
  if (isBooleanType(base)) return "boolean";
  if (isNumberType(base)) return "number";
  return "plain";
}

/**
 * The items of a list resolved one by one, when every one resolved.
 *
 * @param items - Each item, undefined where it did not resolve.
 * @returns The items, or undefined when any of them did not resolve.
 */
export function resolvedAll<T>(items: readonly (T | undefined)[]): T[] | undefined {
  const resolved: T[] = [];
  for (const item of items) {
    if (item === undefined) return undefined;
    resolved.push(item);
  }
  return resolved;
}

class ShapeResolver {
  readonly files = new Set<string>();
  readonly #checker: Checker;

  constructor(checker: Checker) {
    this.#checker = checker;
  }

  /**
   * The shapes a storages argument iterates.
   *
   * @param arg - The storages argument: a storage or an array literal of storages.
   * @returns One shape per storage, or the reason they are not known statically.
   * @throws When a consulted declaration's source file is no longer available.
   */
  async argumentShapes(arg: Expression): Promise<readonly ArchShape[] | Reason> {
    if (isArrayLiteralExpression(arg)) return await this.#elementShapes(arg.elements);
    const type = await consultedType(this.#checker, arg, this.files);
    const shape = await this.#storageShape(type);
    if (shape !== undefined) return [shape];
    // `any` is assignable to an array, so it must not read as a storages list.
    if (!isAnyOrUnknown(type) && (await isArrayLike(this.#checker, type))) {
      return "STORAGES_DYNAMIC";
    }
    return "SHAPE_UNRESOLVED";
  }

  /**
   * The shape of one storage expression.
   *
   * @param storage - A storage expression.
   * @returns The shape, or undefined when its type does not pin one.
   * @throws When a consulted declaration's source file is no longer available.
   */
  async storageShape(storage: Expression): Promise<ArchShape | undefined> {
    return await this.#storageShape(await consultedType(this.#checker, storage, this.files));
  }

  /**
   * Resolves every element of an array literal of storages. One element that does not resolve
   * leaves the storages dynamic, and so does a spread, whose element count is not known statically
   * even when its element type resolves.
   *
   * @param elements - The array literal's elements.
   * @returns One shape per element, or `STORAGES_DYNAMIC`.
   * @throws When a consulted declaration's source file is no longer available.
   */
  async #elementShapes(elements: NodeArray<Expression>): Promise<readonly ArchShape[] | Reason> {
    if (elements.some((element) => isSpreadElement(element))) return "STORAGES_DYNAMIC";
    const shapes = await Promise.all(
      elements.map(async (element) => await this.storageShape(element)),
    );
    return resolvedAll(shapes) ?? "STORAGES_DYNAMIC";
  }

  /**
   * The shape of the archetype a storage type carries. A type parameter resolves through its
   * constraint; a union resolves only when every member has the same shape, since the view would
   * otherwise differ per member.
   *
   * @param storageType - A storage's static type.
   * @returns The shape, or undefined when the type does not pin one.
   * @throws When a consulted declaration's source file is no longer available.
   */
  async #storageShape(storageType: Type): Promise<ArchShape | undefined> {
    const type = await apparentType(this.#checker, storageType);
    if (isAnyOrUnknown(type)) return undefined;
    const members = await unionMembers(type);
    if (members !== undefined) return await this.#unionShape(members);
    const archetype = await this.#property(type, "archetype");
    return archetype === undefined ? undefined : await this.#archetypeShape(archetype);
  }

  async #unionShape(members: readonly Type[]): Promise<ArchShape | undefined> {
    const shapes = await Promise.all(
      members.map(async (member) => await this.#storageShape(member)),
    );
    const [first, ...rest] = resolvedAll(shapes) ?? [];
    if (first === undefined) return undefined;
    const key = shapeKey(first);
    return rest.every((shape) => shapeKey(shape) === key) ? first : undefined;
  }

  async #archetypeShape(archetype: Type): Promise<ArchShape | undefined> {
    const [, required, optional] = await Promise.all([
      consultTypeDeclarations(archetype, this.files),
      this.#componentList(archetype, "components"),
      this.#componentList(archetype, "optionals"),
    ]);
    if (required === undefined || optional === undefined) return undefined;
    return { required, optional };
  }

  /**
   * Reads the component tuple held in the archetype property `name`. Only a tuple of required
   * elements pins the runtime component list: an optional, rest, or variadic element types view
   * slots the storage may not have, and among optionals it shifts every later presence bit.
   *
   * @param archetype - An archetype descriptor type.
   * @param name - The property holding the tuple: `components` or `optionals`.
   * @returns The components in order, or undefined when the tuple does not pin them.
   * @throws When a consulted declaration's source file is no longer available.
   */
  async #componentList(archetype: Type, name: string): Promise<readonly Component[] | undefined> {
    const tuple = await this.#property(archetype, name);
    if (tuple === undefined) return undefined;
    const elements = await requiredTupleElements(this.#checker, tuple);
    if (elements === undefined) return undefined;
    const components = await Promise.all(
      elements.map(async (element) => await this.#component(element)),
    );
    return resolvedAll(components);
  }

  /**
   * Reads a component type: its name from `__ecstatic_name`, which must be a single string literal,
   * and its fields. A relation's fields come from its relation meta, which never lists `target`.
   *
   * @param type - A component descriptor type.
   * @returns The component, or undefined when its type does not pin its name or fields.
   * @throws When a consulted declaration's source file is no longer available.
   */
  async #component(type: Type): Promise<Component | undefined> {
    const [name, relationMeta, componentMeta] = await Promise.all([
      componentName(this.#checker, type, this.files),
      this.#property(type, "__ecstatic_relation_meta"),
      this.#property(type, "__ecstatic_component_meta"),
    ]);
    const meta = relationMeta ?? componentMeta;
    if (name === undefined || meta === undefined) return undefined;
    // The component meta is declared optional, so its type includes undefined.
    const fieldsType = await this.#property(await nonNullableType(this.#checker, meta), "fields");
    if (fieldsType === undefined) return undefined;
    return { name, fields: await this.#fields(fieldsType), relation: relationMeta !== undefined };
  }

  /**
   * Lists the properties of a component's fields type in declaration order. A symbol-keyed
   * property is no field: the runtime enumerates only string keys.
   *
   * @param type - A component's fields type.
   * @returns The fields, each with its column kind.
   * @throws When a consulted declaration's source file is no longer available.
   */
  async #fields(type: Type): Promise<Field[]> {
    const properties = await propertiesOfType(this.#checker, type);
    return await Promise.all(
      properties
        .filter((property) => !isSymbolKeyed(property))
        .map(async (property) => await this.#field(property)),
    );
  }

  /**
   * Reads one field of a component's fields type. A field declared by `ref()` is plain whatever
   * its value type, as the runtime stores every reference in a plain array: without
   * `strictNullChecks`, a `ref<number>()` field's value type `number | undefined` collapses to
   * `number` and would otherwise read as a numeric column.
   *
   * @param property - A property of a component's fields type.
   * @returns The field with its column kind.
   * @throws When a consulted declaration's source file is no longer available.
   */
  async #field(property: CheckerSymbol): Promise<Field> {
    const [, type, isRef] = await Promise.all([
      consultDeclarations(property, this.files),
      typeOfSymbol(this.#checker, property),
      this.#isRefField(property),
    ]);
    const kind = isRef ? "plain" : await fieldKind(this.#checker, type);
    return { name: symbolName(property), kind };
  }

  /**
   * Whether a field is declared by `ref()`. The fields type maps each default to its value type, so
   * the marker survives only on the declaration the mapped property keeps. Declaration emit drops
   * the marker and writes the field's value type joined with `undefined`, which no other field
   * default produces, so a declared type naming `undefined` in a union marks a ref as well.
   *
   * @param property - A property of a component's fields type.
   * @returns Whether its declared type is a union naming `undefined`, or its declaration's type
   *   carries `__ecstatic_ref_marker`.
   * @throws When a declaration's source file is no longer available, or the compiler process has
   *   exited.
   */
  async #isRefField(property: CheckerSymbol): Promise<boolean> {
    const [declaration] = await declarationsOf(property);
    if (declaration === undefined) return false;
    if (isPropertySignatureDeclaration(declaration) && joinsUndefined(declaration.type)) {
      return true;
    }
    const declared = await typeAtLocation(this.#checker, declaration);
    const marker = await propertyOfType(this.#checker, declared, "__ecstatic_ref_marker");
    return marker !== undefined;
  }

  /**
   * The type of a property, whose declarations are consulted.
   *
   * @param type - Type holding the property.
   * @param name - Property name.
   * @returns The property's type, or undefined when `type` has no such property.
   * @throws When a declaration's source file is no longer available.
   */
  async #property(type: Type, name: string): Promise<Type | undefined> {
    return await consultedProperty(this.#checker, type, name, this.files);
  }
}
