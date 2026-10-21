import type { ElementAccessExpression, PropertyAccessExpression } from "typescript/ast";
import { isPropertyAccessExpression } from "typescript/ast/is";

import { type ArchShape, type Component, shapeComponent } from "../facts.js";
import { literalElementKey } from "./roles.js";

/** The view key that reads the entity's id rather than a component. */
export const ID_KEY = "id";

/** What every shape of a site holds under one view key. */
export interface SlotInfo {
  /** The key's component in each shape; empty when no shape resolved. */
  readonly comps: readonly Component[];
  readonly tag: boolean;
}

/**
 * What the shapes hold under a view key. With no shape resolved, every key reads as a data slot.
 *
 * @param shapes - The site's resolved shapes.
 * @param comp - The key.
 * @returns The slot, or undefined when some shape holds no component of that name or the shapes
 *   disagree on whether it is a tag.
 */
export function slotInfo(shapes: readonly ArchShape[], comp: string): SlotInfo | undefined {
  const comps: Component[] = [];
  let tag = false;
  for (const [i, shape] of shapes.entries()) {
    const component = shapeComponent(shape, comp);
    const isTag = component?.fields.length === 0;
    if (component === undefined || (i > 0 && tag !== isTag)) return undefined;
    tag = isTag;
    comps.push(component);
  }
  return { comps, tag };
}

/**
 * The key an access reads from the view: `e.K` for any name, or `e["C"]` whose string literal names
 * a component of the shapes, the only way to reach a component whose name is no identifier. An
 * optional access, `e?.K`, reads no view key. Callers decide whether the receiver is the view, each
 * by its own means, and pass the answer in.
 *
 * @param access - The access to read.
 * @param onView - Whether the access's receiver, past parentheses and non-null assertions, is the
 *   view.
 * @param shapes - The site's resolved shapes.
 * @returns The key, or undefined when `access` reads no view key.
 */
export function viewKey(
  access: PropertyAccessExpression | ElementAccessExpression,
  onView: boolean,
  shapes: readonly ArchShape[],
): string | undefined {
  if (!onView || access.questionDotToken !== undefined) return undefined;
  if (isPropertyAccessExpression(access)) return access.name.text;
  const key = literalElementKey(access);
  return key === undefined || key === ID_KEY || slotInfo(shapes, key) === undefined
    ? undefined
    : key;
}
