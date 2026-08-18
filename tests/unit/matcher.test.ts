import { assert, describe, expect, it } from "vitest";

import {
  archetype,
  components,
  createWorld,
  despawn,
  despawnMany,
  each,
  enable,
  register,
  spawn,
  spawnMany,
} from "../../src/index.js";
import { rowOf } from "./fixtures.js";

const { MatcherPosition: Position } = components({ MatcherPosition: { x: 0, y: 0 } });
const { MatcherStunned: Stunned } = components({ MatcherStunned: {} });
const { MatcherOnFire: OnFire } = components({ MatcherOnFire: {} });

function createStorage() {
  const world = createWorld();
  const storage = register(world, archetype([Position], [Stunned, OnFire]));
  return { world, storage };
}

describe("matcher registration", () => {
  it("dedupes matchers by (all, any, none) triple", () => {
    const { storage } = createStorage();
    spawn(storage);

    each(storage, { all: [Stunned] }, () => {});
    each(storage, { all: [Stunned] }, () => {});
    each(storage, [Stunned], () => {});

    expect(storage.matchers).toHaveLength(1);
  });

  it("registers distinct matchers for distinct triples", () => {
    const { storage } = createStorage();
    spawn(storage);

    each(storage, { all: [Stunned] }, () => {});
    each(storage, { none: [Stunned] }, () => {});

    expect(storage.matchers).toHaveLength(2);
  });

  it("a trivial filter iterates unfiltered and registers no matcher", () => {
    const { storage } = createStorage();
    spawn(storage);
    spawn(storage);

    let count = 0;
    each(storage, { all: [Position] }, () => {
      count += 1;
    });

    expect(count).toBe(2);
    expect(storage.matchers).toHaveLength(0);
  });

  it("a matcher registered on a storage with live rows backfills matched for all of them", () => {
    const { storage } = createStorage();
    const id1 = spawn(storage);
    spawn(storage);
    const id3 = spawn(storage);
    enable(storage, id1, Stunned);
    enable(storage, id3, Stunned);

    // First filtered pass registers the matcher against existing rows.
    const visited: number[] = [];
    each(storage, { all: [Stunned] }, (e) => {
      visited.push(e.id);
    });

    expect(new Set(visited)).toStrictEqual(new Set([id1, id3]));
    const matcher = storage.matchers[0];
    assert(matcher != null);
    expect(matcher.matched[rowOf(storage, id1)]).toBe(1);
    expect(matcher.matched[rowOf(storage, id3)]).toBe(1);
  });
});

describe("matched[] synchronization", () => {
  it("matched arrays survive capacity growth and stay parallel to matchers", () => {
    const { storage } = createStorage();
    const id1 = spawn(storage);
    enable(storage, id1, Stunned);
    each(storage, { all: [Stunned] }, () => {});

    // Grow past the initial capacity of 8.
    spawnMany(storage, 20);

    const matcher = storage.matchers[0];

    assert(matcher != null);
    expect(storage.matcherMatched[0]).toBe(matcher.matched);
    expect(matcher.matched.length).toBe(storage.entities.length);
    expect(matcher.matched[rowOf(storage, id1)]).toBe(1);

    const visited: number[] = [];
    each(storage, { all: [Stunned] }, (e) => {
      visited.push(e.id);
    });
    expect(visited).toStrictEqual([id1]);
  });

  it("spawn refresh is unconditional — recycled rows drop the previous occupant's flags", () => {
    const { storage } = createStorage();
    each(storage, { all: [Stunned] }, () => {});

    const idA = spawn(storage, { MatcherStunned: true });
    despawn(storage, idA);

    // Respawn into the recycled slot with no overrides: the stale matched
    // flag from the previous occupant must be cleared.
    spawn(storage);

    let count = 0;
    each(storage, { all: [Stunned] }, () => {
      count += 1;
    });
    expect(count).toBe(0);
  });

  it("spawnMany refreshes matched for the whole batch", () => {
    const { storage } = createStorage();
    each(storage, { all: [Stunned] }, () => {});

    spawnMany(storage, 3, { MatcherStunned: true });
    spawnMany(storage, 2);

    let count = 0;
    each(storage, { all: [Stunned] }, () => {
      count += 1;
    });
    expect(count).toBe(3);
  });

  it("despawn swap carries the matched flags of the moved row", () => {
    const { storage } = createStorage();
    each(storage, { all: [Stunned] }, () => {});

    spawn(storage);
    const id2 = spawn(storage);
    const id3 = spawn(storage, { MatcherStunned: true });

    // Despawn the middle entity: id3's row swaps into the hole and must stay
    // in the visit set.
    despawn(storage, id2);

    const visited: number[] = [];
    each(storage, { all: [Stunned] }, (e) => {
      visited.push(e.id);
    });
    expect(visited).toStrictEqual([id3]);
  });

  it("despawnMany-with-ids compaction carries matched flags of surviving rows", () => {
    const { storage } = createStorage();
    each(storage, { all: [Stunned] }, () => {});

    const ids = spawnMany(storage, 6);
    const id4 = ids[4];
    assert(id4 != null);
    const id5 = ids[5];
    assert(id5 != null);
    enable(storage, id4, Stunned);
    enable(storage, id5, Stunned);

    // Free early rows so the tail survivors compact down into them.
    const d0 = ids[0];
    assert(d0 != null);
    const d1 = ids[1];
    assert(d1 != null);
    const d2 = ids[2];
    assert(d2 != null);
    despawnMany(storage, [d0, d1, d2]);

    const visited: number[] = [];
    each(storage, { all: [Stunned] }, (e) => {
      visited.push(e.id);
    });
    expect(new Set(visited)).toStrictEqual(new Set([ids[4], ids[5]]));
  });

  it("refresh leaves unrelated matchers' visit sets intact", () => {
    const { storage } = createStorage();
    each(storage, { all: [Stunned] }, () => {});
    each(storage, { all: [OnFire] }, () => {});

    const id1 = spawn(storage, { MatcherOnFire: true });
    const id2 = spawn(storage);

    // Toggling Stunned overlaps only the first matcher's filter mask; the
    // OnFire matcher's flags must be untouched.
    enable(storage, id2, Stunned);

    const onFireVisited: number[] = [];
    each(storage, { all: [OnFire] }, (e) => {
      onFireVisited.push(e.id);
    });
    expect(onFireVisited).toStrictEqual([id1]);

    const stunnedVisited: number[] = [];
    each(storage, { all: [Stunned] }, (e) => {
      stunnedVisited.push(e.id);
    });
    expect(stunnedVisited).toStrictEqual([id2]);
  });
});
