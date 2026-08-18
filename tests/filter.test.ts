import { assert, describe, expect, it } from "vitest";

import {
  archetype,
  components,
  createWorld,
  despawn,
  disable,
  each,
  enable,
  register,
  spawn,
} from "../src/index.js";

const { FilterPosition: Position } = components({ FilterPosition: { x: 0, y: 0 } });
const { FilterVelocity: Velocity } = components({ FilterVelocity: { vx: 0, vy: 0 } });
const { FilterStunned: Stunned } = components({ FilterStunned: {} });
const { FilterOnFire: OnFire } = components({ FilterOnFire: {} });
const { FilterFrozen: Frozen } = components({ FilterFrozen: {} });

function createOnFireStorage() {
  const world = createWorld();
  const storage = register(world, archetype([Position], [OnFire]));
  return { world, storage };
}

function createStunnedOnFireStorage() {
  const world = createWorld();
  const storage = register(world, archetype([Position], [Stunned, OnFire]));
  return { world, storage };
}

describe("filtered each — single archetype", () => {
  it("all filter: only visits entities with tag enabled", () => {
    const { storage } = createOnFireStorage();

    spawn(storage);
    const id2 = spawn(storage);
    spawn(storage);

    enable(storage, id2, OnFire);

    const visited: number[] = [];
    each(storage, { all: [OnFire] }, (e) => {
      visited.push(e.id);
    });

    expect(visited).toStrictEqual([id2]);
  });

  it("none filter: skips entities with tag enabled", () => {
    const world = createWorld();
    const storage = register(world, archetype([Position], [Stunned]));

    const id1 = spawn(storage);
    const id2 = spawn(storage);

    enable(storage, id1, Stunned);

    const visited: number[] = [];
    each(storage, { none: [Stunned] }, (e) => {
      visited.push(e.id);
    });

    expect(visited).toStrictEqual([id2]);
  });

  it("combined all + none filter", () => {
    const { storage } = createStunnedOnFireStorage();

    const id1 = spawn(storage);
    const id2 = spawn(storage);
    spawn(storage);

    enable(storage, id1, OnFire);
    enable(storage, id1, Stunned);
    enable(storage, id2, OnFire);

    const visited: number[] = [];
    each(storage, { all: [OnFire], none: [Stunned] }, (e) => {
      visited.push(e.id);
    });

    expect(visited).toStrictEqual([id2]);
  });

  it("any filter: visits entities with at least one tag", () => {
    const { storage } = createStunnedOnFireStorage();

    const id1 = spawn(storage);
    const id2 = spawn(storage);
    spawn(storage);

    enable(storage, id1, Stunned);
    enable(storage, id2, OnFire);

    const visited: number[] = [];
    each(storage, { any: [Stunned, OnFire] }, (e) => {
      visited.push(e.id);
    });

    expect(visited).toHaveLength(2);
  });

  it("any filter with 3 tags: visits entities matching diverse optional states in reverse order", () => {
    const world = createWorld();
    const storage = register(world, archetype([Position], [Stunned, OnFire, Frozen]));

    spawn(storage); // e0: no tags enabled → not visited
    const e1 = spawn(storage);
    const e2 = spawn(storage);
    const e3 = spawn(storage);
    const e4 = spawn(storage);

    enable(storage, e1, Stunned);
    enable(storage, e2, OnFire);
    enable(storage, e3, Stunned);
    enable(storage, e3, Frozen);
    enable(storage, e4, Stunned);
    enable(storage, e4, OnFire);
    enable(storage, e4, Frozen);

    const visited: number[] = [];
    each(storage, { any: [Stunned, OnFire, Frozen] }, (e) => {
      visited.push(e.id);
    });

    expect(visited).toStrictEqual([e4, e3, e2, e1]);
  });
});

describe("filtered each — edge cases", () => {
  it("despawn during filtered iteration is safe (reverse)", () => {
    const { storage } = createOnFireStorage();

    const id1 = spawn(storage);
    const id2 = spawn(storage);
    const id3 = spawn(storage);

    enable(storage, id1, OnFire);
    enable(storage, id2, OnFire);
    enable(storage, id3, OnFire);

    each(storage, { all: [OnFire] }, (e) => {
      despawn(storage, e.id);
    });

    expect(storage.n).toBe(0);
  });

  it("filter with required comp in 'all': trivially satisfied", () => {
    const { storage } = createOnFireStorage();

    spawn(storage);
    spawn(storage);

    const visited: number[] = [];
    each(storage, { all: [Position] }, (e) => {
      visited.push(e.id);
    });

    expect(visited).toHaveLength(2);
  });

  it("filter with absent comp in 'all': storage skipped entirely", () => {
    const { storage } = createOnFireStorage();

    spawn(storage);

    const visited: number[] = [];
    each(storage, { all: [Velocity] }, (e) => {
      visited.push(e.id);
    });

    expect(visited).toHaveLength(0);
  });

  it("filter with required comp in 'any': any-leg trivially passes", () => {
    const { storage } = createOnFireStorage();

    spawn(storage);
    spawn(storage);

    const visited: number[] = [];
    each(storage, { any: [Position, OnFire] }, (e) => {
      visited.push(e.id);
    });

    expect(visited).toHaveLength(2);
  });

  it("filter with required comp in 'none': storage skipped", () => {
    const { storage } = createOnFireStorage();

    spawn(storage);

    const visited: number[] = [];
    each(storage, { none: [Position] }, (e) => {
      visited.push(e.id);
    });

    expect(visited).toHaveLength(0);
  });

  it("no filter: all entities visited (backward compat)", () => {
    const { storage } = createOnFireStorage();

    spawn(storage);
    spawn(storage);

    let count = 0;
    each(storage, () => {
      count += 1;
    });

    expect(count).toBe(2);
  });

  it("filter visits no entities before any tag is enabled", () => {
    const { storage } = createOnFireStorage();
    spawn(storage);
    spawn(storage);

    let count = 0;
    each(storage, { all: [OnFire] }, () => {
      count += 1;
    });

    expect(count).toBe(0);
  });

  it("filter visits newly enabled entity after enable", () => {
    const { storage } = createOnFireStorage();
    const id1 = spawn(storage);
    spawn(storage);

    enable(storage, id1, OnFire);
    let count = 0;
    each(storage, { all: [OnFire] }, () => {
      count += 1;
    });

    expect(count).toBe(1);
  });

  it("filter excludes entity after disable", () => {
    const { storage } = createOnFireStorage();
    const id1 = spawn(storage);
    spawn(storage);

    enable(storage, id1, OnFire);
    disable(storage, id1, OnFire);
    let count = 0;
    each(storage, { all: [OnFire] }, () => {
      count += 1;
    });

    expect(count).toBe(0);
  });
});

describe("filtered each — mutation during iteration", () => {
  it("enable on unmatched entity during filtered each visits newly matched entity", () => {
    // Reverse iteration visits matched indices from high to low. When
    // visiting the last row, enabling the tag on the first (lower,
    // not-yet-visited) row immediately adds it to matched[], so the loop
    // reaches it in the same pass.
    const { storage } = createOnFireStorage();

    const ids = Array.from({ length: 5 }, () => spawn(storage));
    const id0 = ids[0];
    assert(id0 != null);
    const id4 = ids[4];
    assert(id4 != null);
    enable(storage, id4, OnFire);

    const visited: number[] = [];
    each(storage, { all: [OnFire] }, (e) => {
      visited.push(e.id);
      if (e.id === id4) {
        enable(storage, id0, OnFire);
      }
    });

    expect(visited).toStrictEqual([ids[4], ids[0]]);
  });

  it("disable on not-yet-visited entity during filtered each skips it", () => {
    const { storage } = createOnFireStorage();

    const ids = Array.from({ length: 5 }, () => spawn(storage));
    for (const id of ids) {
      enable(storage, id, OnFire);
    }
    const disableId = ids[0];
    assert(disableId != null);

    const visited: number[] = [];
    each(storage, { all: [OnFire] }, (e) => {
      visited.push(e.id);
      if (e.id === ids[4]) {
        disable(storage, disableId, OnFire);
      }
    });

    expect(visited).toStrictEqual([ids[4], ids[3], ids[2], ids[1]]);

    let countAfter = 0;
    each(storage, { all: [OnFire] }, () => {
      countAfter += 1;
    });
    expect(countAfter).toBe(4);
  });

  it("enable and disable on different entities during filtered each is safe", () => {
    const { storage } = createStunnedOnFireStorage();

    const ids = Array.from({ length: 5 }, () => spawn(storage));
    const mixId0 = ids[0];
    assert(mixId0 != null);
    const mixId1 = ids[1];
    assert(mixId1 != null);
    const mixId2 = ids[2];
    assert(mixId2 != null);
    const mixId3 = ids[3];
    assert(mixId3 != null);
    const mixId4 = ids[4];
    assert(mixId4 != null);
    enable(storage, mixId2, Stunned);
    enable(storage, mixId3, Stunned);
    enable(storage, mixId4, Stunned);

    const visited: number[] = [];
    each(storage, { all: [Stunned] }, (e) => {
      visited.push(e.id);
      if (e.id === mixId4) {
        enable(storage, mixId0, Stunned);
        enable(storage, mixId1, OnFire);
      }
    });

    expect(visited).toStrictEqual([ids[4], ids[3], ids[2], ids[0]]);

    let stunnedCount = 0;
    each(storage, { all: [Stunned] }, () => {
      stunnedCount += 1;
    });
    expect(stunnedCount).toBe(4);

    const onFireVisited: number[] = [];
    each(storage, { all: [OnFire] }, (e) => {
      onFireVisited.push(e.id);
    });
    expect(onFireVisited).toStrictEqual([ids[1]]);
  });

  it("same-storage nested filtered each honors each level's own filter", () => {
    const { storage } = createStunnedOnFireStorage();

    const idBoth = spawn(storage);
    const idStunned = spawn(storage);
    const idOnFire = spawn(storage);
    enable(storage, idBoth, Stunned);
    enable(storage, idBoth, OnFire);
    enable(storage, idStunned, Stunned);
    enable(storage, idOnFire, OnFire);

    const pairs: [number, number][] = [];
    each(storage, { all: [Stunned] }, (outer) => {
      each(storage, { all: [OnFire] }, (inner) => {
        pairs.push([outer.id, inner.id]);
      });
    });

    expect(pairs).toStrictEqual([
      [idStunned, idOnFire],
      [idStunned, idBoth],
      [idBoth, idOnFire],
      [idBoth, idBoth],
    ]);
  });
});

describe("filtered each — array shorthand", () => {
  it("single component array behaves as an all filter", () => {
    const { storage } = createOnFireStorage();

    spawn(storage);
    const id2 = spawn(storage);
    spawn(storage);

    enable(storage, id2, OnFire);

    const visited: number[] = [];
    each(storage, [OnFire], (e) => {
      visited.push(e.id);
    });

    expect(visited).toStrictEqual([id2]);
  });

  it("multiple component array requires all tags enabled", () => {
    const { storage } = createStunnedOnFireStorage();

    const id1 = spawn(storage);
    const id2 = spawn(storage);
    spawn(storage);

    enable(storage, id1, OnFire);
    enable(storage, id1, Stunned);
    enable(storage, id2, OnFire);

    const visited: number[] = [];
    each(storage, [OnFire, Stunned], (e) => {
      visited.push(e.id);
    });

    expect(visited).toStrictEqual([id1]);
  });
});

describe("matcher predicate parity (Alpha ∧ (Beta ∨ Gamma) ∧ ¬Delta)", () => {
  const { ParityAlpha: Alpha } = components({ ParityAlpha: {} });
  const { ParityBeta: Beta } = components({ ParityBeta: {} });
  const { ParityGamma: Gamma } = components({ ParityGamma: {} });
  const { ParityDelta: Delta } = components({ ParityDelta: {} });

  function createParityStorage() {
    const world = createWorld();
    const storage = register(world, archetype([Position], [Alpha, Beta, Gamma, Delta]));
    return { world, storage };
  }

  type ParityStorage = ReturnType<typeof createParityStorage>["storage"];

  function registerMatcher(storage: ParityStorage): void {
    each(storage, { all: [Alpha], any: [Beta, Gamma], none: [Delta] }, () => {});
  }

  function matchedIds(storage: ParityStorage): number[] {
    const visited: number[] = [];
    each(storage, { all: [Alpha], any: [Beta, Gamma], none: [Delta] }, (e) => {
      visited.push(e.id);
    });
    return visited;
  }

  it("maintains the matched set across all/any/none transitions (per-entity enable/disable)", () => {
    const { storage } = createParityStorage();

    // Register BEFORE mutating so enable/disable flow through the incremental
    // refresh — not the matcher's one-shot backfill, which would mask a
    // predicate bug.
    registerMatcher(storage);

    spawn(storage); // {} → no match
    const alpha = spawn(storage); // {Alpha} → no match (any-clause guard)
    const alphaBeta = spawn(storage); // {Alpha,Beta} → match
    const alphaGamma = spawn(storage); // {Alpha,Gamma} → match
    const alphaBetaDelta = spawn(storage); // {Alpha,Beta,Delta} → no match (none excludes)
    const betaGamma = spawn(storage); // {Beta,Gamma} → no match (all fails)

    enable(storage, alpha, Alpha);
    enable(storage, alphaBeta, Alpha);
    enable(storage, alphaBeta, Beta);
    enable(storage, alphaGamma, Alpha);
    enable(storage, alphaGamma, Gamma);
    enable(storage, alphaBetaDelta, Alpha);
    enable(storage, alphaBetaDelta, Beta);
    enable(storage, alphaBetaDelta, Delta);
    enable(storage, betaGamma, Beta);
    enable(storage, betaGamma, Gamma);

    expect(new Set(matchedIds(storage))).toStrictEqual(new Set([alphaBeta, alphaGamma]));

    // Disabling the all-clause tag drops a previously matching entity.
    disable(storage, alphaBeta, Alpha);
    expect(matchedIds(storage)).toStrictEqual([alphaGamma]);
  });

  it("maintains the matched set for plain spawn and spawn-with-overrides", () => {
    const { storage } = createParityStorage();

    registerMatcher(storage);

    spawn(storage); // zero mask → no match
    spawn(storage, { ParityAlpha: true }); // {Alpha} → no match (any-clause guard)
    const alphaBeta = spawn(storage, { ParityAlpha: true, ParityBeta: true });
    const alphaGamma = spawn(storage, { ParityAlpha: true, ParityGamma: true });
    spawn(storage, { ParityAlpha: true, ParityBeta: true, ParityDelta: true }); // none excludes

    expect(new Set(matchedIds(storage))).toStrictEqual(new Set([alphaBeta, alphaGamma]));
  });

  it("enabling a tag outside the filter mask leaves the match set unchanged", () => {
    const { ParityExtra: Extra } = components({ ParityExtra: {} });
    const world = createWorld();
    const storage = register(world, archetype([Position], [Alpha, Beta, Gamma, Delta, Extra]));

    each(storage, { all: [Alpha], any: [Beta, Gamma], none: [Delta] }, () => {});

    const matching = spawn(storage, { ParityAlpha: true, ParityBeta: true });
    const idle = spawn(storage, { ParityAlpha: true });

    // Extra is outside filterMask (Alpha|Beta|Gamma|Delta): the changed-bit
    // relevance check must skip the recompute, leaving each prior result.
    enable(storage, matching, Extra);
    enable(storage, idle, Extra);

    const visited: number[] = [];
    each(storage, { all: [Alpha], any: [Beta, Gamma], none: [Delta] }, (e) => {
      visited.push(e.id);
    });
    expect(visited).toStrictEqual([matching]);
  });
});

describe("filtered each — growth during iteration", () => {
  it("mid-pass enable stays visible after a callback-triggered capacity growth", () => {
    const { storage } = createOnFireStorage();

    // Fill to the initial capacity of 8 so one more spawn forces growth,
    // which replaces the matcher's matched array mid-pass.
    const ids = Array.from({ length: 8 }, () => spawn(storage));
    const growId0 = ids[0];
    assert(growId0 != null);
    const growId7 = ids[7];
    assert(growId7 != null);
    enable(storage, growId7, OnFire);

    const visited: number[] = [];
    each(storage, { all: [OnFire] }, (e) => {
      visited.push(e.id);
      if (e.id === growId7) {
        spawn(storage);
        enable(storage, growId0, OnFire);
      }
    });

    expect(visited).toStrictEqual([ids[7], ids[0]]);
  });
});

describe("filtered each — any axis with only absent components", () => {
  it("skips the storage entirely", () => {
    const { storage } = createOnFireStorage();
    spawn(storage);

    let count = 0;
    each(storage, { any: [Velocity, Frozen] }, () => {
      count += 1;
    });

    expect(count).toBe(0);
  });
});
