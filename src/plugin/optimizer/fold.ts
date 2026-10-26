/**
 * Build-time fold of a literal `each` filter against a storage's shape: the outcome the runtime's
 * `resolveFilterMasks` gives for the same components on a storage of that shape, computed from
 * component names alone.
 */
import { type ArchShape, FILTER_AXES, type FilterElement, type LiteralFilter } from "./facts.js";

interface FoldBase {
  /**
   * Per literal element, in source order (the `all` axis, then `any`, then `none`, each in element
   * order): whether the fold took its component as present in the shape. The `DEBUG` element guard
   * checks each against the storage the call receives.
   */
  readonly present: readonly boolean[];
}

/** The storage can never match: the pass visits no row. */
export interface SkipFold extends FoldBase {
  readonly kind: "skip";
}

/** Every constraint holds on every row: the pass visits rows unfiltered, as `TRIVIAL_MATCHER`. */
export interface TrivialFold extends FoldBase {
  readonly kind: "trivial";
}

/** Rows are selected by the storage's matcher for these optional-bit masks. */
export interface MaskedFold extends FoldBase {
  readonly kind: "masked";
  readonly all: number;
  readonly any: number;
  readonly none: number;
}

export type FoldedFilter = SkipFold | TrivialFold | MaskedFold;

/**
 * Looks up how a component name sits in a shape.
 *
 * @param shape - Shape whose optional, then required, components are searched.
 * @param name - Component name.
 * @returns The component's optional bit, `0` when it is required, or `undefined` when the shape
 *   has no component of that name.
 */
function bitIn(shape: ArchShape, name: string): number | undefined {
  const index = shape.optional.findIndex((component) => component.name === name);
  if (index !== -1) return 1 << index;
  return shape.required.some((component) => component.name === name) ? 0 : undefined;
}

/**
 * Flattens a literal filter's axes into the one list `FoldBase.present` is parallel to.
 *
 * @param filter - The literal filter.
 * @returns Every element, the `all` axis, then `any`, then `none`, each in element order.
 */
export function literalElements(filter: LiteralFilter): readonly FilterElement[] {
  return FILTER_AXES.flatMap((axis) => filter[axis]);
}

/**
 * Combines one axis's members into a mask, as the runtime's bit OR does.
 *
 * @param bits - Each member's bit from {@link bitIn}.
 * @returns The OR of the optional bits; required (`0`) and absent (`undefined`) members add
 *   nothing.
 */
function orBits(bits: readonly (number | undefined)[]): number {
  let mask = 0;
  for (const bit of bits) mask |= bit ?? 0;
  return mask;
}

/**
 * Folds a literal filter against a shape, mirroring `resolveFilterMasks` axis by axis:
 *
 * - `all`: a required component is satisfied, an optional one contributes its bit, an absent one
 *   makes the outcome Skip.
 * - `any`: optional members contribute bits, a required member clears the axis to 0, and a
 *   non-empty axis whose members are all absent is Skip.
 * - `none`: optional members contribute bits, a required member is Skip, absent members are
 *   ignored.
 *
 * Three zero masks are Trivial; anything else is Masked.
 *
 * @param filter - The literal filter, its elements naming components.
 * @param shape - The shape of the storage the filter is resolved against; `optional[k]` has bit
 *   `1 << k`, as the runtime assigns it.
 * @returns The outcome, with the presence the fold took for every element whatever the outcome.
 */
export function foldFilter(filter: LiteralFilter, shape: ArchShape): FoldedFilter {
  const bitsOf = (elements: readonly FilterElement[]): (number | undefined)[] =>
    elements.map((element) => bitIn(shape, element.name));
  const all = bitsOf(filter.all);
  const any = bitsOf(filter.any);
  const none = bitsOf(filter.none);
  const present = [...all, ...any, ...none].map((bit) => bit !== undefined);

  const anySatisfied = any.includes(0);
  const anyPossible = any.length === 0 || any.some((bit) => bit !== undefined);
  if (all.includes(undefined) || !anyPossible || none.includes(0)) {
    return { kind: "skip", present };
  }

  const allMask = orBits(all);
  const anyMask = anySatisfied ? 0 : orBits(any);
  const noneMask = orBits(none);
  if (allMask === 0 && anyMask === 0 && noneMask === 0) {
    return { kind: "trivial", present };
  }
  return { kind: "masked", all: allMask, any: anyMask, none: noneMask, present };
}
