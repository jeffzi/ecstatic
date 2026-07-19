import { describe, expect, it } from "vitest";
import {
  archetype,
  components,
  createWorld,
  despawn,
  each,
  get,
  ref,
  register,
  set,
  spawn,
} from "../src/index.js";

const { ViewTestPosition: Position } = components({
  ViewTestPosition: { x: 0, y: 0 },
});
const { ViewTestVelocity: Velocity } = components({
  ViewTestVelocity: { vx: 0, vy: 0 },
});
const { ViewTestHealth: Health } = components({
  ViewTestHealth: { hp: 100, maxHp: 100 },
});
const { ViewTestRefComp: RefComp } = components({
  ViewTestRefComp: { data: ref<number[]>() },
});

describe("view — field access", () => {
  it("reads and writes fields via view", () => {
    const world = createWorld();
    const Arch = archetype([Position, Velocity]);
    const storage = register(world, Arch);

    const id = spawn(storage, {
      ViewTestPosition: { x: 10, y: 20 },
      ViewTestVelocity: { vx: 1, vy: 2 },
    });

    each(storage, (e) => {
      // biome-ignore lint/suspicious/noExplicitAny: view is dynamically generated
      expect((e as any).ViewTestPosition.x).toBe(10);
      // biome-ignore lint/suspicious/noExplicitAny: view is dynamically generated
      expect((e as any).ViewTestPosition.y).toBe(20);
      // biome-ignore lint/suspicious/noExplicitAny: view is dynamically generated
      (e as any).ViewTestPosition.x = 99;
      // biome-ignore lint/suspicious/noExplicitAny: view is dynamically generated
      (e as any).ViewTestPosition.y = 88;
    });

    expect(get(storage, id, Position.x)).toBe(99);
    expect(get(storage, id, Position.y)).toBe(88);
  });

  it("compound assignment lands in storage", () => {
    const world = createWorld();
    const Arch = archetype([Position, Velocity]);
    const storage = register(world, Arch);

    const id = spawn(storage, {
      ViewTestPosition: { x: 10, y: 20 },
      ViewTestVelocity: { vx: 3, vy: 4 },
    });

    each(storage, (e) => {
      // biome-ignore lint/suspicious/noExplicitAny: view is dynamically generated
      (e as any).ViewTestPosition.x += (e as any).ViewTestVelocity.vx;
      // biome-ignore lint/suspicious/noExplicitAny: view is dynamically generated
      (e as any).ViewTestPosition.y += (e as any).ViewTestVelocity.vy;
    });

    expect(get(storage, id, Position.x)).toBe(13);
    expect(get(storage, id, Position.y)).toBe(24);
  });

  it("increment and decrement land in storage", () => {
    const world = createWorld();
    const Arch = archetype([Position]);
    const storage = register(world, Arch);

    const id = spawn(storage, {
      ViewTestPosition: { x: 5, y: 10 },
    });

    each(storage, (e) => {
      // biome-ignore lint/suspicious/noExplicitAny: view is dynamically generated
      (e as any).ViewTestPosition.x++;
      // biome-ignore lint/suspicious/noExplicitAny: view is dynamically generated
      (e as any).ViewTestPosition.y--;
    });

    expect(get(storage, id, Position.x)).toBe(6);
    expect(get(storage, id, Position.y)).toBe(9);
  });

  it("compound forms match expanded spelling", () => {
    const world = createWorld();
    const Arch = archetype([Position, Velocity]);
    const s1 = register(world, Arch);
    const s2 = register(world, Arch);

    const id1 = spawn(s1, {
      ViewTestPosition: { x: 10, y: 0 },
      ViewTestVelocity: { vx: 3, vy: 0 },
    });
    const id2 = spawn(s2, {
      ViewTestPosition: { x: 10, y: 0 },
      ViewTestVelocity: { vx: 3, vy: 0 },
    });

    // Compound form
    each(s1, (e) => {
      // biome-ignore lint/suspicious/noExplicitAny: view is dynamically generated
      (e as any).ViewTestPosition.x += (e as any).ViewTestVelocity.vx;
    });

    // Expanded form
    each(s2, (e) => {
      // biome-ignore lint/suspicious/noExplicitAny: view is dynamically generated
      (e as any).ViewTestPosition.x =
        // biome-ignore lint/suspicious/noExplicitAny: view is dynamically generated
        (e as any).ViewTestPosition.x + (e as any).ViewTestVelocity.vx;
    });

    expect(get(s1, id1, Position.x)).toBe(get(s2, id2, Position.x));
  });

  it("ref field readable and writable", () => {
    const world = createWorld();
    const Arch = archetype([Position, RefComp]);
    const storage = register(world, Arch);

    const arr = [1, 2, 3];
    const id = spawn(storage, {
      ViewTestPosition: { x: 0, y: 0 },
      ViewTestRefComp: { data: arr },
    });

    let readData: number[] | undefined;
    each(storage, (e) => {
      // biome-ignore lint/suspicious/noExplicitAny: view is dynamically generated
      readData = (e as any).ViewTestRefComp.data;
      // biome-ignore lint/suspicious/noExplicitAny: view is dynamically generated
      (e as any).ViewTestRefComp.data = [4, 5];
    });

    expect(readData).toBe(arr);
    const after = get(storage, id, RefComp.data);
    expect(after).toBeDefined();
    expect(after![0]).toBe(4);
    expect(after![1]).toBe(5);
  });
});

describe("view — e.id operations", () => {
  it("e.id is a valid entity id", () => {
    const world = createWorld();
    const Arch = archetype([Position]);
    const storage = register(world, Arch);

    const id = spawn(storage, {
      ViewTestPosition: { x: 7, y: 8 },
    });

    let capturedId: number | undefined;
    each(storage, (e) => {
      capturedId = e.id;
    });
    expect(capturedId).toBe(id);
  });

  it("despawn via e.id mid-loop is safe", () => {
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

  it("get/set via e.id work", () => {
    const world = createWorld();
    const Arch = archetype([Position]);
    const storage = register(world, Arch);

    const id = spawn(storage, {
      ViewTestPosition: { x: 1, y: 2 },
    });

    each(storage, (e) => {
      const x = get(storage, e.id, Position.x);
      if (typeof x === "number") {
        set(storage, e.id, Position.x, x + 100);
      }
    });

    expect(get(storage, id, Position.x)).toBe(101);
  });
});

describe("view — nested each", () => {
  it("pairwise pattern: inner/outer field writes do not interfere", () => {
    const world = createWorld();
    const Arch = archetype([Position]);
    const storage = register(world, Arch);

    spawn(storage, { ViewTestPosition: { x: 1, y: 0 } });
    spawn(storage, { ViewTestPosition: { x: 2, y: 0 } });

    // Sum of all other entities' x into own y (pairwise)
    each(storage, (outer) => {
      each(storage, (inner) => {
        if (outer.id !== inner.id) {
          // biome-ignore lint/suspicious/noExplicitAny: view is dynamically generated
          (outer as any).ViewTestPosition.y += (inner as any).ViewTestPosition.x;
        }
      });
    });

    // Backward: entity 2 then entity 1
    // Entity 2 (x=2): y = 1 (from entity 1)
    // Entity 1 (x=1): y = 2 (from entity 2)
    const ys: number[] = [];
    each(storage, (e) => {
      // biome-ignore lint/suspicious/noExplicitAny: view is dynamically generated
      ys.push((e as any).ViewTestPosition.y);
    });
    // Reverse order: entity 2 then entity 1
    expect(ys[0]).toBe(1); // entity 2: y = 1
    expect(ys[1]).toBe(2); // entity 1: y = 2
  });

  it("outer view fields readable inside inner callback", () => {
    const world = createWorld();
    const Arch = archetype([Position]);
    const storage = register(world, Arch);

    spawn(storage, { ViewTestPosition: { x: 10, y: 0 } });
    spawn(storage, { ViewTestPosition: { x: 20, y: 0 } });

    let sum = 0;
    each(storage, (outer) => {
      each(storage, () => {
        // biome-ignore lint/suspicious/noExplicitAny: view is dynamically generated
        sum += (outer as any).ViewTestPosition.x;
      });
    });

    // 2 outer × 2 inner = 4 visits; outer.x is 10 twice and 20 twice = 60
    expect(sum).toBe(60);
  });

  it("inner loop despawns its own current entity without affecting outer iteration", () => {
    const world = createWorld();
    const OuterArch = archetype([Position, Velocity]);
    const InnerArch = archetype([Health]);
    const outer = register(world, OuterArch);
    const inner = register(world, InnerArch);

    spawn(outer);
    spawn(outer);
    spawn(inner, { ViewTestHealth: { hp: 10, maxHp: 100 } });
    spawn(inner, { ViewTestHealth: { hp: 20, maxHp: 100 } });
    spawn(inner, { ViewTestHealth: { hp: 30, maxHp: 100 } });

    let outerVisits = 0;
    each(outer, () => {
      outerVisits++;
      each(inner, (e) => {
        despawn(inner, e.id);
      });
    });

    // Both outer entities visited
    expect(outerVisits).toBe(2);
    // Inner storage fully drained (first outer pass despawns all 3)
    expect(inner.n).toBe(0);
  });
});
