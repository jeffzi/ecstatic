/**
 * Reads of the fields a symbol or type carries once the compiler process has sent it: its name,
 * ID, flags, and literal value. None of them makes a call into the process.
 */

import {
  type CheckerSymbol,
  isStringLiteralType,
  SymbolFlags,
  type Type,
  TypeFlags,
} from "../compiler.js";

/**
 * The display name of `symbol`.
 *
 * @param symbol - Symbol to name.
 * @returns Its name without escaping.
 */
export function symbolName(symbol: CheckerSymbol): string {
  return symbol.name;
}

/** How the compiler API spells the name of a property keyed by a unique symbol: `__@iterator@12`. */
const SYMBOL_KEY_PREFIX = "__@";

/**
 * Whether `symbol` is a property keyed by a symbol value, such as `[Symbol.iterator]`, rather than
 * by a name. Such a key has no string the runtime could enumerate.
 *
 * @param symbol - Property to test.
 * @returns Whether its key is a symbol.
 */
export function isSymbolKeyed(symbol: CheckerSymbol): boolean {
  return symbol.name.startsWith(SYMBOL_KEY_PREFIX);
}

/**
 * Whether `symbol` is a get or set accessor.
 *
 * @param symbol - Symbol to inspect; undefined is no accessor.
 * @returns Whether `symbol` is an accessor.
 */
export function isAccessorSymbol(symbol: CheckerSymbol | undefined): boolean {
  return symbol !== undefined && (symbol.flags & SymbolFlags.Accessor) !== 0;
}

/**
 * Whether `symbol`, a type's symbol, names an object literal, a type literal, or no declaration at
 * all: an object type with no class or interface behind it.
 *
 * @param symbol - The type's symbol; undefined for a type no declaration names.
 * @returns Whether the type is anonymous.
 */
export function isAnonymousObjectSymbol(symbol: CheckerSymbol | undefined): boolean {
  return (
    symbol === undefined ||
    (symbol.flags & (SymbolFlags.ObjectLiteral | SymbolFlags.TypeLiteral)) !== 0
  );
}

/**
 * The identity of `type` within its program, the same for every object that stands for it.
 *
 * @param type - Type to identify.
 * @returns Its ID.
 */
export function typeId(type: Type): number {
  return type.id;
}

/**
 * Whether `type` is `any` or `unknown`.
 *
 * @param type - Type to test.
 * @returns Whether it is `any` or `unknown`.
 */
export function isAnyOrUnknown(type: Type): boolean {
  return (type.flags & TypeFlags.AnyOrUnknown) !== 0;
}

/**
 * Whether `type` is `boolean` or a boolean literal.
 *
 * @param type - Type to test.
 * @returns Whether it is boolean.
 */
export function isBooleanType(type: Type): boolean {
  return (type.flags & TypeFlags.BooleanLike) !== 0;
}

/**
 * Whether `type` is `number` or a number literal.
 *
 * @param type - Type to test.
 * @returns Whether it is a number.
 */
export function isNumberType(type: Type): boolean {
  return (type.flags & TypeFlags.NumberLike) !== 0;
}

/**
 * Whether `type` is a primitive, such as `number` or a string literal, or `never`.
 *
 * @param type - Type to test; a union or intersection tests as neither.
 * @returns Whether every value of `type` is a primitive.
 */
export function isPrimitiveOrNever(type: Type): boolean {
  return (type.flags & (TypeFlags.Primitive | TypeFlags.Never)) !== 0;
}

/**
 * Whether `type` is `null`, `undefined`, or `void`.
 *
 * @param type - Type to test; a union tests as none of them.
 * @returns Whether `type` holds only `null` or `undefined`.
 */
export function isNullishOrVoid(type: Type): boolean {
  return (type.flags & (TypeFlags.Nullable | TypeFlags.Void)) !== 0;
}

/**
 * The value of a single string literal type.
 *
 * @param type - Type to read; undefined has no value.
 * @returns The literal's value, or undefined for any other type, a union of literals included.
 */
export function stringLiteralValue(type: Type | undefined): string | undefined {
  return type !== undefined && isStringLiteralType(type) ? type.value : undefined;
}
