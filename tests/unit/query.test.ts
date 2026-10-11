import { describe, expect, it } from "vitest";

import {
  archetype,
  components,
  createWorld,
  despawn,
  destroyWorld,
  disable,
  each,
  enable,
  get,
  has,
  query,
  register,
  spawn,
} from "../../src/index.js";

const { QueryPosition: Position } = components({ QueryPosition: { x: 0, y: 0 } });
const { QueryVelocity: Velocity } = components({ QueryVelocity: { vx: 0, vy: 0 } });
const { QueryHealth: Health } = components({ QueryHealth: { hp: 100 } });
const { QueryStunned: Stunned } = components({ QueryStunned: {} });
const { QueryOnFire: OnFire } = components({ QueryOnFire: {} });

describe("query — shorthand (component array)", () => {
  it("visits entities in archetypes containing all requested components", () => {
    const world = createWorld();
    const posOnly = register(world, archetype([Position]));
    const posVel = register(world, archetype([Position, Velocity]));

    const id1 = spawn(posOnly);
    const id2 = spawn(posVel);

    const visited: number[] = [];
    query(world, [Position], (e) => {
      visited.push(e.id);
    });

    expect(new Set(visited)).toStrictEqual(new Set([id1, id2]));
  });

  it("skips archetypes missing any requested component", () => {
    const world = createWorld();
    const posOnly = register(world, archetype([Position]));
    const posVel = register(world, archetype([Position, Velocity]));

    spawn(posOnly);
    const id2 = spawn(posVel);

    const visited: number[] = [];
    query(world, [Position, Velocity], (e) => {
      visited.push(e.id);
    });

    expect(visited).toStrictEqual([id2]);
  });

  it("skips empty matching archetypes", () => {
    const world = createWorld();
    register(world, archetype([Position]));
    const posVel = register(world, archetype([Position, Velocity]));

    const id = spawn(posVel);

    const visited: number[] = [];
    query(world, [Position], (e) => {
      visited.push(e.id);
    });

    expect(visited).toStrictEqual([id]);
  });

  it("reads and writes fields through the view", () => {
    const world = createWorld();
    const storage = register(world, archetype([Position]));
    const id = spawn(storage, { QueryPosition: { x: 3 } });

    query(world, [Position], (e) => {
      e.QueryPosition.x += 1;
    });

    expect(get(storage, id, Position.x)).toBe(4);
  });

  it("errors on an empty component array", () => {
    const world = createWorld();

    expect(() => {
      // @ts-expect-error the empty tuple is rejected at the type level too
      query(world, [], () => {});
    }).toThrow("query requires at least one component");
  });
});

describe("query — filter descriptor", () => {
  it("all filter: visits entities with required component AND tag enabled", () => {
    const world = createWorld();
    const storage = register(world, archetype([Position], [Stunned]));

    const id1 = spawn(storage, { QueryStunned: true });
    spawn(storage);

    const visited: number[] = [];
    query(world, { all: [Position, Stunned] }, (e) => {
      visited.push(e.id);
    });

    expect(visited).toStrictEqual([id1]);
  });

  it("none filter: skips entities with tag enabled", () => {
    const world = createWorld();
    const storage = register(world, archetype([Position], [Stunned]));

    spawn(storage, { QueryStunned: true });
    const id2 = spawn(storage);

    const visited: number[] = [];
    query(world, { all: [Position], none: [Stunned] }, (e) => {
      visited.push(e.id);
    });

    expect(visited).toStrictEqual([id2]);
  });

  it("any filter: visits entities with at least one tag enabled", () => {
    const world = createWorld();
    const storage = register(world, archetype([Position], [Stunned, OnFire]));

    const id1 = spawn(storage, { QueryStunned: true });
    const id2 = spawn(storage, { QueryOnFire: true });
    spawn(storage);

    const visited: number[] = [];
    query(world, { all: [Position], any: [Stunned, OnFire] }, (e) => {
      visited.push(e.id);
    });

    expect(new Set(visited)).toStrictEqual(new Set([id1, id2]));
  });

  it("required component in none: whole archetype skipped", () => {
    const world = createWorld();
    const posVel = register(world, archetype([Position, Velocity]));
    const posOnly = register(world, archetype([Position]));

    spawn(posVel);
    const id2 = spawn(posOnly);

    const visited: number[] = [];
    query(world, { all: [Position], none: [Velocity] }, (e) => {
      visited.push(e.id);
    });

    expect(visited).toStrictEqual([id2]);
  });

  it("tag-only all filter: finds archetypes with the tag as optional and visits enabled entities", () => {
    const world = createWorld();
    const storage = register(world, archetype([Position], [Stunned]));

    const id1 = spawn(storage, { QueryStunned: true });
    spawn(storage);

    const visited: number[] = [];
    query(world, { all: [Stunned] }, (e) => {
      visited.push(e.id);
    });

    expect(visited).toStrictEqual([id1]);
  });

  it("filters across multiple archetypes", () => {
    const world = createWorld();
    const a = register(world, archetype([Position], [Stunned]));
    const b = register(world, archetype([Position, Velocity], [Stunned]));

    const id1 = spawn(a, { QueryStunned: true });
    spawn(a);
    const id2 = spawn(b, { QueryStunned: true });
    spawn(b);

    const visited: number[] = [];
    query(world, { all: [Position, Stunned] }, (e) => {
      visited.push(e.id);
    });

    expect(new Set(visited)).toStrictEqual(new Set([id1, id2]));
  });

  it("errors on an empty all axis", () => {
    const world = createWorld();

    expect(() => {
      // @ts-expect-error the empty all axis is rejected at the type level too
      query(world, { all: [] }, () => {});
    }).toThrow("query requires at least one component");
  });
});

describe("query — identity + epoch cache", () => {
  it("second call with the same filter object returns the same results", () => {
    const world = createWorld();
    const storage = register(world, archetype([Position]));
    const id = spawn(storage);

    const filter = { all: [Position] } as const;
    const first: number[] = [];
    query(world, filter, (e) => {
      first.push(e.id);
    });
    const second: number[] = [];
    query(world, filter, (e) => {
      second.push(e.id);
    });

    expect(first).toStrictEqual([id]);
    expect(second).toStrictEqual([id]);
  });

  it("registering a new matching archetype after a query makes the next identical query see it", () => {
    const world = createWorld();
    const a = register(world, archetype([Position]));
    const id1 = spawn(a);

    const filter = { all: [Position] } as const;
    const first: number[] = [];
    query(world, filter, (e) => {
      first.push(e.id);
    });
    expect(first).toStrictEqual([id1]);

    const b = register(world, archetype([Position, Velocity]));
    const id2 = spawn(b);

    const second: number[] = [];
    query(world, filter, (e) => {
      second.push(e.id);
    });
    expect(new Set(second)).toStrictEqual(new Set([id1, id2]));
  });

  it("does not reuse a cached query for a different descriptor set", () => {
    const world = createWorld();
    const posOnly = register(world, archetype([Position]));
    const posVel = register(world, archetype([Position, Velocity]));
    const id1 = spawn(posOnly);
    const id2 = spawn(posVel);

    const wide: number[] = [];
    query(world, [Position], (e) => {
      wide.push(e.id);
    });
    const narrow: number[] = [];
    query(world, [Position, Velocity], (e) => {
      narrow.push(e.id);
    });

    expect(new Set(wide)).toStrictEqual(new Set([id1, id2]));
    expect(narrow).toStrictEqual([id2]);
  });

  it("keeps two worlds queried with the same filter object isolated", () => {
    const worldA = createWorld();
    const worldB = createWorld();
    const a = register(worldA, archetype([Position]));
    const b = register(worldB, archetype([Position]));
    const idA = spawn(a);
    const idB = spawn(b);

    const filter = { all: [Position] } as const;
    const visitedA: number[] = [];
    query(worldA, filter, (e) => {
      visitedA.push(e.id);
    });
    const visitedB: number[] = [];
    query(worldB, filter, (e) => {
      visitedB.push(e.id);
    });

    expect(visitedA).toStrictEqual([idA]);
    expect(visitedB).toStrictEqual([idB]);
  });

  it("destroyWorld invalidates the cache", () => {
    const world = createWorld();
    const storage = register(world, archetype([Position]));
    spawn(storage);

    const filter = { all: [Position] } as const;
    let count = 0;
    query(world, filter, () => {
      count += 1;
    });
    expect(count).toBe(1);

    destroyWorld(world);

    let after = 0;
    query(world, filter, () => {
      after += 1;
    });
    expect(after).toBe(0);
  });
});

describe("query — trivial matcher optimization", () => {
  it("trivial query visits all entities regardless of tag state and registers no matcher", () => {
    const world = createWorld();
    const storage = register(world, archetype([Position], [Stunned]));

    spawn(storage, { QueryStunned: true });
    spawn(storage);

    let count = 0;
    query(world, [Position], () => {
      count += 1;
    });

    expect(count).toBe(2);
    expect(storage.matchers).toHaveLength(0);
  });

  it("trivial and filtered queries coexist on the same archetype", () => {
    const world = createWorld();
    const storage = register(world, archetype([Position], [Stunned]));

    const id1 = spawn(storage, { QueryStunned: true });
    spawn(storage);

    let all = 0;
    query(world, [Position], () => {
      all += 1;
    });
    const filtered: number[] = [];
    query(world, { all: [Position, Stunned] }, (e) => {
      filtered.push(e.id);
    });

    expect(all).toBe(2);
    expect(filtered).toStrictEqual([id1]);
  });

  it("new entities spawned after the cache is warm are visited", () => {
    const world = createWorld();
    const storage = register(world, archetype([Position]));
    spawn(storage);

    const filter = [Position] as const;
    let first = 0;
    query(world, filter, () => {
      first += 1;
    });
    expect(first).toBe(1);

    spawn(storage);
    let second = 0;
    query(world, filter, () => {
      second += 1;
    });
    expect(second).toBe(2);
  });
});

describe("query — safety and callbacks", () => {
  it("despawn during query is safe (reverse iteration)", () => {
    const world = createWorld();
    const storage = register(world, archetype([Position]));
    spawn(storage);
    spawn(storage);
    spawn(storage);

    query(world, [Position], (e) => {
      despawn(world, e.id);
    });

    expect(storage.n).toBe(0);
  });

  it("enable/disable/has work inside query callbacks via the world form", () => {
    const world = createWorld();
    const storage = register(world, archetype([Position], [Stunned]));
    spawn(storage);
    spawn(storage);

    expect.hasAssertions();
    query(world, [Position], (e) => {
      enable(world, e.id, Stunned);
      expect(has(world, e.id, Stunned)).toBe(true);
      disable(world, e.id, Stunned);
      expect(has(world, e.id, Stunned)).toBe(false);
    });

    let stunnedCount = 0;
    query(world, { all: [Stunned] }, () => {
      stunnedCount += 1;
    });
    expect(stunnedCount).toBe(0);
  });
});

describe("query — nested iteration", () => {
  it("query-in-query cross-archetype visit accounting is correct", () => {
    const world = createWorld();
    const a = register(world, archetype([Position]));
    const b = register(world, archetype([Position, Velocity]));
    spawn(a);
    spawn(a);
    spawn(b);

    let pairs = 0;
    query(world, [Position], () => {
      query(world, [Position], () => {
        pairs += 1;
      });
    });

    // 3 outer × 3 inner
    expect(pairs).toBe(9);
  });

  it("query inside each visits the right rows at each level", () => {
    const world = createWorld();
    const movers = register(world, archetype([Position, Velocity]));
    const markers = register(world, archetype([Health], [Stunned]));
    const m1 = spawn(movers);
    const t1 = spawn(markers, { QueryStunned: true });
    spawn(markers);

    const pairs: [number, number][] = [];
    each(movers, (outer) => {
      query(world, { all: [Stunned] }, (inner) => {
        pairs.push([outer.id, inner.id]);
      });
    });

    expect(pairs).toStrictEqual([[m1, t1]]);
  });
});
