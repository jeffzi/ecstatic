import { describe, expect, it } from "vitest";

import { type ArchetypeDescriptor, archetype } from "../../../src/ecstatic/archetype.js";
import { type ComponentDescriptor, component } from "../../../src/ecstatic/component.js";
import { resolveFilterMasks, TRIVIAL_MATCHER } from "../../../src/ecstatic/filter.js";
import { createWorld, register } from "../../../src/ecstatic/world.js";
import type {
  ArchShape,
  Component,
  FilterElement,
  LiteralFilter,
} from "../../../src/plugin/optimizer/facts.js";
import { type FoldedFilter, foldFilter } from "../../../src/plugin/optimizer/fold.js";

const Position = component("FoldPosition");
const Shield = component("FoldShield");
const Stunned = component("FoldStunned");
const Boost = component("FoldBoost");
const Velocity = component("FoldVelocity");
const Frozen = component("FoldFrozen");

/** Position required; Shield, Stunned, and Boost optional; Velocity and Frozen absent. */
const SHIP = archetype([Position], [Shield, Stunned, Boost]);

/** The components of one literal filter, per axis, in source order. */
interface Axes {
  readonly all?: readonly ComponentDescriptor[];
  readonly any?: readonly ComponentDescriptor[];
  readonly none?: readonly ComponentDescriptor[];
}

/** The component fact the analysis records for a field-less, non-relation descriptor. */
function componentFact(descriptor: ComponentDescriptor): Component {
  return { name: descriptor.__ecstatic_name, fields: [], relation: false };
}

/** The shape fact the analysis records for `arch`: both lists in declaration order. */
function shapeOf(arch: ArchetypeDescriptor): ArchShape {
  return {
    required: arch.components.map(componentFact),
    optional: arch.optionals.map(componentFact),
  };
}

/** The literal filter fact for `axes`, numbering element nodes in source order. */
function literalFilter(axes: Axes): LiteralFilter {
  let node = 0;
  const elements = (comps: readonly ComponentDescriptor[] = []): FilterElement[] =>
    comps.map((comp) => ({ node: (node += 1), name: comp.__ecstatic_name }));
  return {
    kind: "literal",
    all: elements(axes.all),
    any: elements(axes.any),
    none: elements(axes.none),
  };
}

/** The fold the runtime gives for `axes` on a fresh storage of `arch`. */
function runtimeFold(arch: ArchetypeDescriptor, axes: Axes): FoldedFilter {
  const { all = [], any = [], none = [] } = axes;
  const storage = register(createWorld(), arch);
  const present = [...all, ...any, ...none].map((comp) => storage.componentLookup.has(comp));
  const matcher = resolveFilterMasks(storage, all, any, none);
  if (matcher === false) return { kind: "skip", present };
  if (matcher === TRIVIAL_MATCHER) return { kind: "trivial", present };
  return {
    kind: "masked",
    all: matcher.allMask,
    any: matcher.anyMask,
    none: matcher.noneMask,
    present,
  };
}

describe("foldFilter", () => {
  describe("against a shape of the storage the runtime resolves", () => {
    it.each<{ name: string; axes: Axes }>([
      { name: "every axis empty", axes: {} },
      { name: "all: a required component", axes: { all: [Position] } },
      { name: "all: an optional component", axes: { all: [Stunned] } },
      { name: "all: an absent component", axes: { all: [Velocity] } },
      { name: "all: a required and two optionals", axes: { all: [Boost, Position, Shield] } },
      { name: "all: a duplicated optional", axes: { all: [Stunned, Stunned] } },
      { name: "all: an absent after an optional", axes: { all: [Shield, Frozen] } },
      { name: "any: an optional component", axes: { any: [Boost] } },
      { name: "any: two optionals", axes: { any: [Shield, Boost] } },
      { name: "any: a required component", axes: { any: [Position] } },
      { name: "any: a required after an optional", axes: { any: [Stunned, Position] } },
      { name: "any: only absent components", axes: { any: [Velocity, Frozen] } },
      { name: "any: an absent and an optional", axes: { any: [Frozen, Shield] } },
      { name: "any: a duplicated optional", axes: { any: [Boost, Boost] } },
      { name: "none: an optional component", axes: { none: [Shield] } },
      { name: "none: a required component", axes: { none: [Position] } },
      { name: "none: an absent component", axes: { none: [Velocity] } },
      { name: "none: an absent and an optional", axes: { none: [Frozen, Boost] } },
      { name: "none: a duplicated optional", axes: { none: [Stunned, Stunned] } },
      {
        name: "an optional on each axis",
        axes: { all: [Shield], any: [Stunned], none: [Boost] },
      },
      {
        name: "a required all with a required any and an absent none",
        axes: { all: [Position], any: [Position, Shield], none: [Velocity] },
      },
      {
        name: "an optional all with only absent any members",
        axes: { all: [Shield], any: [Velocity], none: [Boost] },
      },
      {
        name: "an optional all with a required none",
        axes: { all: [Shield], any: [Stunned], none: [Position] },
      },
      {
        name: "an absent all with present members on the other axes",
        axes: { all: [Velocity, Shield], any: [Stunned, Frozen], none: [Position, Boost] },
      },
      {
        name: "an empty any between an optional all and an optional none",
        axes: { all: [Boost], any: [], none: [Shield] },
      },
    ])("gives the runtime's outcome and element presence for $name", ({ axes }) => {
      const expected = runtimeFold(SHIP, axes);

      const folded = foldFilter(literalFilter(axes), shapeOf(SHIP));

      expect(folded).toStrictEqual(expected);
    });
  });
});
