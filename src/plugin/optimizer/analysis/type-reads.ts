/**
 * Whether reading a value of a static type can run user code: a getter, a conversion through
 * `toString` or `valueOf`, or a container's iteration.
 */

import {
  apparentType,
  type Checker,
  hasCallSignatures,
  intersectionMembers,
  isAccessorProperty,
  isAccessorSymbol,
  isAnonymousObjectSymbol,
  isAnyOrUnknown,
  isArrayOrTuple,
  isNullishOrVoid,
  isPrimitiveOrNever,
  propertiesOfType,
  type Type,
  typeId,
  typeOfSymbol,
  typeSymbol,
  unionMembers,
} from "../compiler.js";

/**
 * The members of a union or intersection.
 *
 * @param type - The type to split.
 * @returns The members, or undefined when `type` is neither.
 */
async function constituents(type: Type): Promise<readonly Type[] | undefined> {
  return (await unionMembers(type)) ?? (await intersectionMembers(type));
}

/**
 * Whether `test` holds for some member of a list, tested concurrently.
 *
 * @param members - The members to test.
 * @param test - The test.
 * @returns Whether any member passes.
 */
async function someMember(
  members: readonly Type[],
  test: (member: Type) => Promise<boolean>,
): Promise<boolean> {
  return (await Promise.all(members.map(test))).some(Boolean);
}

/**
 * Whether `test` holds for every member of a list, tested concurrently.
 *
 * @param members - The members to test.
 * @param test - The test.
 * @returns Whether every member passes.
 */
async function everyMember(
  members: readonly Type[],
  test: (member: Type) => Promise<boolean>,
): Promise<boolean> {
  return (await Promise.all(members.map(test))).every(Boolean);
}

/**
 * Whether reading a value of a type can run user code, settled without looking at properties: the
 * type is `any` or `unknown`, or `test` holds for some member of its union or intersection.
 *
 * @param type - The receiver's type.
 * @param test - The test for one member.
 * @returns The verdict, or undefined when `type` is neither and its properties decide.
 */
async function readRunsInConstituents(
  type: Type,
  test: (member: Type) => Promise<boolean>,
): Promise<boolean | undefined> {
  if (isAnyOrUnknown(type)) return true;
  const members = await constituents(type);
  return members === undefined ? undefined : await someMember(members, test);
}

/**
 * Whether every value of a type is a primitive: a union of primitive types, or an intersection
 * with one, such as a branded number.
 *
 * @param type - The type to test.
 * @returns Whether the type holds only primitives.
 */
export async function isPrimitiveType(type: Type): Promise<boolean> {
  const union = await unionMembers(type);
  if (union !== undefined) return await everyMember(union, isPrimitiveType);
  const intersection = await intersectionMembers(type);
  if (intersection !== undefined) return await someMember(intersection, isPrimitiveType);
  return isPrimitiveOrNever(type);
}

/**
 * Whether a type holds only `null` and `undefined`.
 *
 * @param type - The type to test.
 * @returns Whether every value of the type is nullish.
 */
export async function isNullishType(type: Type): Promise<boolean> {
  const union = await unionMembers(type);
  if (union !== undefined) return await everyMember(union, isNullishType);
  return isNullishOrVoid(type);
}

/**
 * Whether reading or writing property `name` of a value of a type can run user code: the type
 * declares the property as an accessor, or the type is `any` or `unknown` and so declares nothing.
 *
 * @param checker - Checker that produced `type`.
 * @param type - The receiver's type.
 * @param name - The property name.
 * @returns Whether the access can run user code.
 */
export async function typeReadRuns(checker: Checker, type: Type, name: string): Promise<boolean> {
  const settled = await readRunsInConstituents(
    type,
    async (member) => await typeReadRuns(checker, member, name),
  );
  if (settled !== undefined) return settled;
  return await isAccessorProperty(checker, await apparentType(checker, type), name);
}

/**
 * Whether reading some property of a value of a type can run user code: the type declares an
 * accessor, or it is `any` or `unknown`.
 *
 * @param checker - Checker that produced `type`.
 * @param type - The receiver's type.
 * @returns Whether some read can run user code.
 */
export async function anyReadRuns(checker: Checker, type: Type): Promise<boolean> {
  const settled = await readRunsInConstituents(
    type,
    async (member) => await anyReadRuns(checker, member),
  );
  if (settled !== undefined) return settled;
  const properties = await propertiesOfType(checker, await apparentType(checker, type));
  return properties.some(isAccessorSymbol);
}

/**
 * Settles a walk of a type's properties without looking at them: a walk that has nothing left to
 * read, or reads only primitives, is safe; `any` and `unknown` are not; a union or intersection is
 * safe when every member is.
 *
 * @param type - The type being walked.
 * @param exhausted - Whether the walk has nothing left to read at `type`.
 * @param test - The walk applied to one member of a union or intersection.
 * @returns The verdict, or undefined when `type`'s properties decide.
 */
async function settleWalk(
  type: Type,
  exhausted: boolean,
  test: (member: Type) => Promise<boolean>,
): Promise<boolean | undefined> {
  if (exhausted || (await isPrimitiveType(type))) return true;
  if (isAnyOrUnknown(type)) return false;
  const members = await constituents(type);
  return members === undefined ? undefined : await everyMember(members, test);
}

/**
 * Whether a type declares no accessor and `test` holds for the type of every property, tested
 * concurrently.
 *
 * @param checker - Checker that produced `type`.
 * @param type - The object type whose properties are walked.
 * @param test - The walk applied to a property's type.
 * @returns Whether the type declares no accessor and every property passes.
 */
async function dataPropertiesPass(
  checker: Checker,
  type: Type,
  test: (propertyType: Type) => Promise<boolean>,
): Promise<boolean> {
  const properties = await propertiesOfType(checker, await apparentType(checker, type));
  if (properties.some(isAccessorSymbol)) return false;
  const safe = await Promise.all(
    properties.map(async (property) => test(await typeOfSymbol(checker, property))),
  );
  return safe.every(Boolean);
}

/**
 * Whether reading the properties of a value of a type, to `depth` levels, runs no getter: every
 * property the type declares at those levels is a data property.
 *
 * @param checker - Checker that produced `type`.
 * @param type - The argument's type.
 * @param depth - How many levels of properties are read.
 * @returns Whether the reads run no user code.
 */
export async function dataOnly(checker: Checker, type: Type, depth: number): Promise<boolean> {
  const settled = await settleWalk(
    type,
    depth === 0,
    async (member) => await dataOnly(checker, member, depth),
  );
  if (settled !== undefined) return settled;
  return await dataPropertiesPass(
    checker,
    type,
    async (propertyType) => await dataOnly(checker, propertyType, depth - 1),
  );
}

/**
 * Whether `setResource`'s deep clone of a value of a type runs no user code: every value it
 * reaches is a primitive, a function, which the clone keeps by reference, or a plain object whose
 * properties are data properties. An array, a tuple, a `Map` or `Set`, a `Date`, and any other
 * class instance or named object type are hazards: the clone iterates the containers, and a named
 * type may be implemented by a class whose methods it calls.
 *
 * @param checker - Checker that produced `type`.
 * @param type - The value's type.
 * @param seen - The IDs of the object types already walked on this path, so a recursive type ends
 *   the walk.
 * @returns Whether the clone runs no user code.
 */
export async function cloneSafe(
  checker: Checker,
  type: Type,
  seen: ReadonlySet<number>,
): Promise<boolean> {
  const settled = await settleWalk(
    type,
    seen.has(typeId(type)),
    async (member) => await cloneSafe(checker, member, seen),
  );
  if (settled !== undefined) return settled;
  const [callable, container, symbol] = await Promise.all([
    hasCallSignatures(checker, type),
    isArrayOrTuple(checker, type),
    typeSymbol(type),
  ]);
  if (callable) return true;
  if (container || !isAnonymousObjectSymbol(symbol)) return false;
  const walked = new Set([...seen, typeId(type)]);
  return await dataPropertiesPass(
    checker,
    type,
    async (propertyType) => await cloneSafe(checker, propertyType, walked),
  );
}
