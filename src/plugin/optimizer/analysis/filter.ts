/**
 * Reads an `each` call's filter argument: literal when its syntax and its elements' types pin every
 * component it names, otherwise the form its syntax fixes, or failing that its static type gives.
 */

import type { Expression } from "typescript/ast";
import {
  isArrayLiteralExpression,
  isIdentifier,
  isObjectLiteralExpression,
  isOmittedExpression,
  isPropertyAssignment,
  isSpreadElement,
} from "typescript/ast/is";

import {
  admitsArray,
  apparentType,
  type Checker,
  hasCallSignatures,
  isArrayLike,
  type Type,
  unionMembers,
} from "../compiler.js";
import {
  type Filter,
  FILTER_AXES,
  type FilterAxis,
  type FilterElement,
  type FilterForm,
} from "../facts.js";
import type { NodeTable } from "../nodes.js";
import { isAnyOrUnknown, typeId } from "./checker-fields.js";
import { componentName, consultedType, consultTypeDeclarations } from "./consulted.js";
import type { PackageRoots } from "./roots.js";
import { resolvedAll } from "./shape.js";
import { isPrimitiveType } from "./type-reads.js";

/** An `each` call's filter argument, read, its nodes not yet registered. */
export interface FilterReading {
  /** The declaration files the reading consulted, sorted and without duplicates. */
  readonly declarationFiles: readonly string[];
  /** Registers the filter's nodes in source order and gives the filter's fact. */
  readonly register: () => Filter;
}

const AXES: ReadonlySet<string> = new Set(FILTER_AXES);

/** A literal filter's element, before its node is registered. */
interface LiteralElement {
  readonly axis: FilterAxis;
  readonly node: Expression;
}

/** A literal filter's element with the component name its type pins. */
interface NamedElement extends LiteralElement {
  readonly name: string;
}

/** The form of one member of a filter's type, a union's members split. */
type MemberForm = "array" | "object" | "unsupported";

/**
 * Reads an `each` call's filter argument. A literal filter reports each element's component name;
 * any other filter, one whose syntax is not literal or one with an element whose type does not pin
 * a single name, reports its form: an array or object literal's from its syntax, any other
 * expression's from its static type.
 *
 * @param checker - Checker of the program holding `filter`.
 * @param table - The file's node table, which the filter's nodes join on registration.
 * @param filter - The call's filter argument.
 * @param roots - The package roots, whose runtime files the reading consults but does not follow.
 * @returns The reading, with the declaration files it consulted.
 * @throws When a consulted declaration's source file is no longer available, or the compiler process
 *   has exited.
 */
export async function readFilter(
  checker: Checker,
  table: NodeTable,
  filter: Expression,
  roots: PackageRoots,
): Promise<FilterReading> {
  const files = new Set<string>();
  const elements = literalElements(filter);
  const named =
    elements === undefined ? undefined : await namedElements(checker, elements, files, roots);
  let register: () => Filter;
  if (named !== undefined) {
    register = () => registerLiteral(table, named);
  } else {
    const form =
      syntacticForm(filter) ??
      (await filterForm(checker, await consultedType(checker, filter, files, roots), files));
    register = () => ({ kind: "non-literal", node: table.register(filter), form });
  }
  return { declarationFiles: [...files].toSorted(), register };
}

/**
 * The form a filter's syntax alone fixes: an array literal is an array and an object literal an
 * object, whatever its contents' types. Reading the form from syntax keeps the files declaring
 * those contents out of the site's declaration files, since no change to them can change the form.
 *
 * @param filter - The filter argument.
 * @returns `"array"` or `"object"` for a literal, undefined for any other expression.
 */
function syntacticForm(filter: Expression): FilterForm | undefined {
  if (isArrayLiteralExpression(filter)) return "array";
  if (isObjectLiteralExpression(filter)) return "object";
  return undefined;
}

/**
 * Whether `key` names a filter axis.
 *
 * @param key - The property key.
 * @returns Whether it is `all`, `any`, or `none`.
 */
function isAxis(key: string): key is FilterAxis {
  return AXES.has(key);
}

/**
 * The elements of a filter whose syntax is literal at every level, in source order.
 *
 * @param filter - The filter argument.
 * @returns Each element with its axis, a bare array's in `all`, or undefined when the filter is not
 *   an array literal or an object literal of axes each written as `key: [ … ]`, or holds a spread
 *   or an omitted element.
 */
function literalElements(filter: Expression): LiteralElement[] | undefined {
  if (isArrayLiteralExpression(filter)) return axisElements("all", filter.elements);
  if (!isObjectLiteralExpression(filter)) return undefined;
  const seen = new Set<FilterAxis>();
  const elements: LiteralElement[] = [];
  for (const property of filter.properties) {
    if (!isPropertyAssignment(property) || !isIdentifier(property.name)) return undefined;
    const key = property.name.text;
    // A repeated axis leaves only its last value for the runtime to read.
    if (!isAxis(key) || seen.has(key) || !isArrayLiteralExpression(property.initializer)) {
      return undefined;
    }
    seen.add(key);
    const axis = axisElements(key, property.initializer.elements);
    if (axis === undefined) return undefined;
    elements.push(...axis);
  }
  return elements;
}

/**
 * The elements of one axis's array literal.
 *
 * @param axis - The axis the array literal is written for.
 * @param nodes - The array literal's elements.
 * @returns The elements, or undefined when one is a spread or omitted.
 */
function axisElements(
  axis: FilterAxis,
  nodes: readonly Expression[],
): LiteralElement[] | undefined {
  if (nodes.some((node) => isSpreadElement(node) || isOmittedExpression(node))) return undefined;
  return nodes.map((node) => ({ axis, node }));
}

/**
 * Names each element by the component its type pins.
 *
 * @param checker - Checker of the program holding the elements.
 * @param elements - The literal filter's elements.
 * @param files - The consulted declaration files, which every element's join.
 * @param roots - The package roots, which locate the ecstatic runtime.
 * @returns The elements in the same order, each with its name, or undefined when any element's
 *   type does not pin one.
 * @throws When a consulted declaration's source file is no longer available, or the compiler process
 *   has exited.
 */
async function namedElements(
  checker: Checker,
  elements: readonly LiteralElement[],
  files: Set<string>,
  roots: PackageRoots,
): Promise<NamedElement[] | undefined> {
  const named = await Promise.all(
    elements.map(async (element) => {
      const type = await consultedType(checker, element.node, files, roots);
      const name = await componentName(checker, type, files);
      return name === undefined ? undefined : { ...element, name };
    }),
  );
  return resolvedAll(named);
}

/**
 * Registers a literal filter's elements in source order.
 *
 * @param table - The file's node table.
 * @param elements - The named elements in source order.
 * @returns The literal filter.
 */
function registerLiteral(table: NodeTable, elements: readonly NamedElement[]): Filter {
  const axes: Record<FilterAxis, FilterElement[]> = { all: [], any: [], none: [] };
  for (const { axis, node, name } of elements) {
    axes[axis].push({ node: table.register(node), name });
  }
  return { kind: "literal", ...axes };
}

/**
 * The form a non-literal filter's type gives.
 *
 * @param checker - Checker that produced `type`.
 * @param type - The filter's static type.
 * @param files - The consulted declaration files, which those of the type's members join.
 * @returns The form.
 * @throws When a consulted declaration's source file is no longer available, or the compiler process
 *   has exited.
 */
async function filterForm(checker: Checker, type: Type, files: Set<string>): Promise<FilterForm> {
  const forms = new Set(await memberForms(checker, type, files));
  if (forms.has("unsupported")) return "unsupported";
  if (forms.has("array")) return forms.has("object") ? "mixed" : "array";
  return "object";
}

/**
 * The form of each member of a type. A type parameter reads through its constraint.
 *
 * @param checker - Checker that produced `type`.
 * @param type - The type, a union split into its members.
 * @param files - The consulted declaration files, which those of each member's declaration join.
 * @returns One form per member, and both `"array"` and `"object"` for a member that is not
 *   array-like but that an array is assignable to, such as `object`: `each` tells the two apart
 *   at runtime.
 * @throws When a consulted declaration's source file is no longer available, or the compiler process
 *   has exited.
 */
async function memberForms(
  checker: Checker,
  type: Type,
  files: Set<string>,
): Promise<MemberForm[]> {
  if (isAnyOrUnknown(type)) return ["unsupported"];
  const members = await unionMembers(type);
  if (members !== undefined) {
    const forms = await Promise.all(
      members.map(async (member) => memberForms(checker, member, files)),
    );
    return forms.flat();
  }
  if (await isPrimitiveType(type)) return ["unsupported"];
  const apparent = await apparentType(checker, type);
  if (typeId(apparent) !== typeId(type)) return await memberForms(checker, apparent, files);
  const [, callable, arrayLike] = await Promise.all([
    consultTypeDeclarations(type, files),
    hasCallSignatures(checker, type),
    isArrayLike(checker, type),
  ]);
  if (callable) return ["unsupported"];
  if (arrayLike) return ["array"];
  return (await admitsArray(checker, type)) ? ["array", "object"] : ["object"];
}
