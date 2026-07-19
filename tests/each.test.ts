import { describe, expect, it } from "vitest";
import {
  archetype,
  components,
  createWorld,
  despawn,
  each,
  get,
  register,
  set,
  spawn,
  spawnMany,
} from "../src/index.js";

const { EachTestPosition: Position } = components({
  EachTestPosition: { x: 0, y: 0 },
});
const { EachTestVelocity: Velocity } = components({
  EachTestVelocity: { vx: 0, vy: 0 },
});
const { EachTestHealth: Health } = components({
  EachTestHealth: { hp: 100, maxHp: 100 },
});

describe("each — single archetype", () => {
  it("calls callback once per entity with correct args", () => {
    const world = createWorld();
    const Arch = archetype([Position, Velocity]);
    const storage = register(world, Arch);

    const id1 = spawn(storage);
    const id2 = spawn(storage);

    const visitedIds: number[] = [];
    each(storage, (e) => {
      visitedIds.push(e.id);
    });

    // Backward iteration: id2 first (higher index), then id1
    expect(visitedIds).toHaveLength(2);
    expect(visitedIds[0]).toBe(id2);
    expect(visitedIds[1]).toBe(id1);
  });

  it("provides read/write access to SOA arrays via named view", () => {
    const world = createWorld();
    const Arch = archetype([Position]);
    const storage = register(world, Arch);

    spawn(storage, {
      EachTestPosition: { x: 10, y: 20 },
    });

    let readX = 0;
    let readY = 0;
    each(storage, (e) => {
      // biome-ignore lint/suspicious/noExplicitAny: view is dynamically generated
      readX = (e as any).EachTestPosition.x;
      // biome-ignore lint/suspicious/noExplicitAny: view is dynamically generated
      readY = (e as any).EachTestPosition.y;
      // biome-ignore lint/suspicious/noExplicitAny: view is dynamically generated
      (e as any).EachTestPosition.x = 99;
    });

    expect(readX).toBe(10);
    expect(readY).toBe(20);
    expect(storage.columns.get(Position)!.x![0]).toBe(99);
  });

  it("skips callback if archetype is empty", () => {
    const world = createWorld();
    const Arch = archetype([Position]);
    const storage = register(world, Arch);

    let called = false;
    each(storage, () => {
      called = true;
    });

    expect(called).toBe(false);
  });

  it("iterates all entities created via spawn", () => {
    const world = createWorld();
    const Arch = archetype([Position, Health]);
    const storage = register(world, Arch);

    const id1 = spawn(storage, {
      EachTestPosition: { x: 1, y: 0 },
      EachTestHealth: { hp: 50, maxHp: 50 },
    });
    const id2 = spawn(storage, {
      EachTestPosition: { x: 2, y: 0 },
      EachTestHealth: { hp: 75, maxHp: 75 },
    });

    const visitedIds: number[] = [];
    each(storage, (e) => {
      visitedIds.push(e.id);
    });

    // Backward: id2 then id1
    expect(visitedIds).toHaveLength(2);
    expect(visitedIds[0]).toBe(id2);
    expect(visitedIds[1]).toBe(id1);
  });
});

describe("each — edge cases", () => {
  it("despawn during iteration is safe (backward iteration built-in)", () => {
    const world = createWorld();
    const Arch = archetype([Position]);
    const storage = register(world, Arch);

    spawn(storage);
    spawn(storage);
    spawn(storage);

    each(storage, (e) => {
      despawn(storage, e.id);
    });

    expect(storage.n).toBe(0);
  });

  it("view accessors survive column growth during iteration", () => {
    const world = createWorld();
    const Arch = archetype([Position]);
    const storage = register(world, Arch);

    // Create initial entities to reach initial capacity (8)
    const initialIds: number[] = [];
    for (let i = 0; i < 8; i++) {
      initialIds.push(spawn(storage, { EachTestPosition: { x: i, y: 0 } }));
    }

    let spawnedMidPass: number | null = null;
    let colGrew = false;
    each(storage, (e) => {
      // On the first iteration (last entity due to backward), spawn entities to trigger growth
      if (spawnedMidPass === null) {
        for (let i = 0; i < 10; i++) {
          spawn(storage, { EachTestPosition: { x: 100 + i, y: 0 } });
        }
        spawnedMidPass = 1;
        colGrew = true;
      }
      // Write through the view — must work even after column growth
      // biome-ignore lint/suspicious/noExplicitAny: view is dynamically generated
      (e as any).EachTestPosition.x = (e as any).EachTestPosition.x + 1000;
    });

    // After iteration, all initially-present entities should have their values incremented
    expect(colGrew).toBe(true);
    for (let i = 0; i < 8; i++) {
      const pos = storage.columns.get(Position)!;
      // Entities are stored at indices 0-7; backward iteration means we wrote to indices 7,6,5...0
      expect(pos.x![i]).toBe(i + 1000);
    }
    // Spawned-mid-pass entities should not have been visited/incremented
    expect(storage.n).toBe(18); // 8 original + 10 spawned
  });

  it("spawned entities mid-pass are not visited in current pass", () => {
    const world = createWorld();
    const Arch = archetype([Position]);
    const storage = register(world, Arch);

    const id1 = spawn(storage, { EachTestPosition: { x: 1, y: 0 } });
    const id2 = spawn(storage, { EachTestPosition: { x: 2, y: 0 } });

    const visitedIds: number[] = [];
    each(storage, (e) => {
      visitedIds.push(e.id);
      // Backward iteration passes the append point first
      spawn(storage, { EachTestPosition: { x: 99, y: 0 } });
    });

    // Only the 2 entities that existed before each() started should be visited
    expect(visitedIds).toHaveLength(2);
    expect(visitedIds).toContain(id1);
    expect(visitedIds).toContain(id2);
    // But we spawned 2 new entities, so n should be 4
    expect(storage.n).toBe(4);
  });

  it("boolean fields read/write through the view", () => {
    const world = createWorld();
    const { EachTestFlag: Flag } = components({
      EachTestFlag: { enabled: false },
    });
    const Arch = archetype([Position, Flag]);
    const storage = register(world, Arch);

    spawn(storage, {
      EachTestPosition: { x: 0, y: 0 },
      EachTestFlag: { enabled: true },
    });

    let readEnabled = false;
    each(storage, (e) => {
      // biome-ignore lint/suspicious/noExplicitAny: view is dynamically generated
      readEnabled = (e as any).EachTestFlag.enabled;
      // biome-ignore lint/suspicious/noExplicitAny: view is dynamically generated
      (e as any).EachTestFlag.enabled = false;
    });

    expect(readEnabled).toBe(true);
    const flagCol = storage.columns.get(Flag)!;
    // Boolean false should be stored as 0 in Uint8Array
    expect(flagCol.enabled![0]).toBe(0);
  });
});

describe("component set — archetype declared via spread", () => {
  const Transform = [Position, Velocity] as const;

  it("spawns an entity and reads default field values", () => {
    const world = createWorld();
    const storage = register(world, archetype([...Transform, Health]));
    const id = spawn(storage);

    expect(get(storage, id, Position.x)).toBe(0);
    expect(get(storage, id, Position.y)).toBe(0);
    expect(get(storage, id, Health.hp)).toBe(100);
  });

  it("writes and reads back field values", () => {
    const world = createWorld();
    const storage = register(world, archetype([...Transform, Health]));
    const id = spawn(storage);

    set(storage, id, Position.x, 42);
    expect(get(storage, id, Position.x)).toBe(42);
  });

  it("iterates all entities via each()", () => {
    const world = createWorld();
    const storage = register(world, archetype([...Transform, Health]));
    spawn(storage);
    spawn(storage);
    spawn(storage);

    let count = 0;
    each(storage, (e) => {
      count++;
      // biome-ignore lint/suspicious/noExplicitAny: view is dynamically generated
      expect((e as any).EachTestPosition.x).toBeDefined();
    });
    expect(count).toBe(3);
  });

  it("produces identical results to inline-declared archetype", () => {
    const world = createWorld();
    const spread = register(world, archetype([...Transform, Health]));
    const inline = register(world, archetype([Position, Velocity, Health]));

    const sid = spawn(spread, { EachTestPosition: { x: 10, y: 20 } });
    const iid = spawn(inline, { EachTestPosition: { x: 10, y: 20 } });

    expect(get(spread, sid, Position.x)).toBe(get(inline, iid, Position.x));
    expect(get(spread, sid, Position.y)).toBe(get(inline, iid, Position.y));
    expect(get(spread, sid, Health.hp)).toBe(get(inline, iid, Health.hp));
  });
});

describe("each — created via spawnMany", () => {
  it("spawned entities are accessible via each() with correct storage.n", () => {
    const world = createWorld();
    const Arch = archetype([Position]);
    const storage = register(world, Arch);

    const ids = spawnMany(storage, 3);

    const visited: number[] = [];
    each(storage, (e) => {
      visited.push(e.id);
    });

    expect(visited).toHaveLength(3);
    for (const id of ids) {
      expect(visited).toContain(id);
    }
    expect(storage.n).toBe(3);
  });
});
