/**
 * Shared component and archetype definitions for the benchmark suite.
 *
 * Archetypes are module-scoped so every bench in a run reuses the same
 * descriptors: `archetype()` caches by component set, and a fresh descriptor
 * per bench would give each one a cold component-resolution path and make the
 * numbers incomparable.
 */

import { archetype, components } from "ecstatic";

// ---------------------------------------------------------------------------
// Shared component descriptors
// ---------------------------------------------------------------------------

export const { Aggro } = components({ Aggro: {} });
export const { Alive } = components({ Alive: {} });
export const { Armor } = components({ Armor: { def: 10 } });
export const { Health } = components({ Health: { hp: 100 } });
export const { Position } = components({ Position: { x: 0, y: 0 } });
export const { Velocity } = components({ Velocity: { dx: 0, dy: 0 } });

// ---------------------------------------------------------------------------
// Shared world-setup archetypes (used by the helpers.ts bench infrastructure)
// ---------------------------------------------------------------------------

export const trackedArch = archetype([Position, Velocity], [Alive]);
export const bgArch = archetype([Health, Armor], [Aggro]);

// ---------------------------------------------------------------------------
// entity / batch spawn archetypes
// ---------------------------------------------------------------------------

export const emptyArch = archetype([]);
export const spawnArch = archetype([Position], [Alive]);

// ---------------------------------------------------------------------------
// iteration archetypes
// ---------------------------------------------------------------------------

export const { A: CompA } = components({ A: { v: 0 } });
export const { B: CompB } = components({ B: { v: 0 } });
export const { C: CompC } = components({ C: { v: 0 } });
export const { D: CompD } = components({ D: { v: 0 } });
export const { E: CompE } = components({ E: { v: 0 } });

export const chainArch = archetype([CompA, CompB, CompC, CompD, CompE]);

export const { F1 } = components({ F1: { a: 0 } });
export const { F2 } = components({ F2: { a: 0, b: 0 } });
export const { F5 } = components({ F5: { a: 0, b: 0, c: 0, d: 0, e: 0 } });
export const { F10 } = components({
  F10: {
    a: 0,
    b: 0,
    c: 0,
    d: 0,
    e: 0,
    f: 0,
    g: 0,
    h: 0,
    i: 0,
    j: 0,
  },
});

export const soa1Arch = archetype([F1]);
export const soa2Arch = archetype([F2]);
export const soa5Arch = archetype([F5]);
export const soa10Arch = archetype([F10]);
