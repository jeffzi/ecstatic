import { describe, expect, it } from "vitest";

import {
  archetype,
  components,
  createWorld,
  despawn,
  each,
  enable,
  get,
  query,
  ref,
  register,
  set,
  spawn,
} from "../../../src/ecstatic/index.js";

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
      expect(e.ViewTestPosition.x).toBe(10);
      expect(e.ViewTestPosition.y).toBe(20);
      e.ViewTestPosition.x = 99;
      e.ViewTestPosition.y = 88;
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
      e.ViewTestPosition.x += e.ViewTestVelocity.vx;
      e.ViewTestPosition.y += e.ViewTestVelocity.vy;
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
      e.ViewTestPosition.x++;
      e.ViewTestPosition.y--;
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

    each(s1, (e) => {
      e.ViewTestPosition.x += e.ViewTestVelocity.vx;
    });

    each(s2, (e) => {
      e.ViewTestPosition.x = e.ViewTestPosition.x + e.ViewTestVelocity.vx;
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
      readData = e.ViewTestRefComp.data;
      e.ViewTestRefComp.data = [4, 5];
    });

    expect(readData).toBe(arr);
    const after = get(storage, id, RefComp.data);
    expect(after).toBeDefined();
    expect(after?.[0]).toBe(4);
    expect(after?.[1]).toBe(5);
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

  it("get/set via e.id work", () => {
    const world = createWorld();
    const Arch = archetype([Position]);
    const storage = register(world, Arch);

    const id = spawn(storage, {
      ViewTestPosition: { x: 1, y: 2 },
    });

    each(storage, (e) => {
      const x = get(storage, e.id, Position.x);
      set(storage, e.id, Position.x, x + 100);
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

    each(storage, (outer) => {
      each(storage, (inner) => {
        if (outer.id !== inner.id) {
          outer.ViewTestPosition.y += inner.ViewTestPosition.x;
        }
      });
    });

    // Backward iteration: entity 2 (x=2) accumulates y from entity 1,
    // entity 1 (x=1) accumulates y from entity 2.
    const ys: number[] = [];
    each(storage, (e) => {
      ys.push(e.ViewTestPosition.y);
    });
    expect(ys[0]).toBe(1);
    expect(ys[1]).toBe(2);
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
        sum += outer.ViewTestPosition.x;
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

    expect(outerVisits).toBe(2);
    // Inner storage fully drained (first outer pass despawns all 3)
    expect(inner.n).toBe(0);
  });
});

describe("view — optional accessors", () => {
  const { ViewOptPos: OptPos } = components({ ViewOptPos: { x: 0, y: 0 } });
  const { ViewOptShield: OptShield } = components({ ViewOptShield: { hp: 50, defense: 10 } });
  const { ViewOptStunned: OptStunned } = components({ ViewOptStunned: {} });
  const { ViewOptOnFire: OptOnFire } = components({ ViewOptOnFire: {} });

  function createOptStorage() {
    const world = createWorld();
    const storage = register(world, archetype([OptPos, OptOnFire], [OptShield, OptStunned]));
    return { world, storage };
  }

  it("reads an enabled data optional as its mutable fields record", () => {
    const { storage } = createOptStorage();
    const id = spawn(storage, { ViewOptShield: { hp: 75 } });

    const hpSeen: (number | undefined)[] = [];
    each(storage, (e) => {
      hpSeen.push(e.ViewOptShield?.hp);
      if (e.ViewOptShield != null) e.ViewOptShield.hp = 33;
    });

    expect(hpSeen).toStrictEqual([75]);
    expect(get(storage, id, OptShield.hp)).toBe(33);
  });

  it("reads a disabled data optional as undefined", () => {
    const { storage } = createOptStorage();
    spawn(storage);

    expect.hasAssertions();
    each(storage, (e) => {
      expect(e.ViewOptShield).toBeUndefined();
    });
  });

  it("reads an optional tag as true/undefined matching enablement", () => {
    const { storage } = createOptStorage();
    const idOn = spawn(storage, { ViewOptStunned: true });
    const idOff = spawn(storage);

    const seen = new Map<number, true | undefined>();
    each(storage, (e) => {
      seen.set(e.id, e.ViewOptStunned);
    });

    expect(seen.get(idOn)).toBe(true);
    expect(seen.get(idOff)).toBeUndefined();
  });

  it("reads a required tag as literal true", () => {
    const { storage } = createOptStorage();
    spawn(storage);

    expect.hasAssertions();
    each(storage, (e) => {
      expect(e.ViewOptOnFire).toBe(true);
    });
  });

  it("enable/disable inside the loop changes what later-bound rows read in the same pass", () => {
    const { storage } = createOptStorage();
    // Iteration is reverse (last row first): enabling the tag on the
    // first-spawned entity from the last-spawned entity's callback must make
    // the later-bound row read it in the same pass.
    const idFirst = spawn(storage);
    const idLast = spawn(storage);

    const seen: (true | undefined)[] = [];
    each(storage, (e) => {
      if (e.id === idLast) {
        enable(storage, idFirst, OptStunned);
      }
      seen.push(e.ViewOptStunned);
    });

    expect(seen).toStrictEqual([undefined, true]);
  });

  it("reads through column growth (accessors stay live after the arrays are replaced)", () => {
    const { storage } = createOptStorage();
    const first = spawn(storage, { ViewOptShield: { hp: 1 } });

    each(storage, (e) => {
      // Bind once so the view exists, then grow the storage past its initial
      // capacity — the same accessor objects must read the replaced columns.
      expect(e.ViewOptShield?.hp).toBe(1);
    });
    for (let i = 0; i < 20; i++) {
      spawn(storage);
    }
    set(storage, first, OptShield.hp, 7);

    let hpOfFirst: number | undefined;
    each(storage, (e) => {
      if (e.id === first) {
        hpOfFirst = e.ViewOptShield?.hp;
      }
    });
    expect(hpOfFirst).toBe(7);
  });
});

describe("view — enumerable accessors", () => {
  const { ViewEnumPlace: Place } = components({ ViewEnumPlace: { x: 0, y: 0 } });
  const { ViewEnumFlag: Flag } = components({ ViewEnumFlag: { active: false, count: 0 } });
  const { ViewEnumShield: Shield } = components({ ViewEnumShield: { hp: 50, defense: 10 } });
  const { ViewEnumBurning: Burning } = components({ ViewEnumBurning: {} });
  const { ViewEnumStunned: Stunned } = components({ ViewEnumStunned: {} });

  /** Serializes a view to JSON and parses it back, as a consumer of the JSON would see it. */
  function roundTrip(view: object): unknown {
    return JSON.parse(JSON.stringify(view));
  }

  it.each([
    {
      label: "Object.keys",
      read: (place: object): unknown => Object.keys(place),
      expected: ["x", "y"],
    },
    {
      label: "JSON.stringify",
      read: (place: object): unknown => JSON.stringify(place),
      expected: '{"x":1,"y":2}',
    },
    { label: "spread", read: (place: object): unknown => ({ ...place }), expected: { x: 1, y: 2 } },
  ])("exposes a data component's fields to $label", ({ read, expected }) => {
    const storage = register(createWorld(), archetype([Place]));
    spawn(storage, { ViewEnumPlace: { x: 1, y: 2 } });

    const seen: unknown[] = [];
    each(storage, (e) => {
      seen.push(read(e.ViewEnumPlace));
    });

    expect(seen).toStrictEqual([expected]);
  });

  it("keeps a spread unchanged by a later write through the view", () => {
    const storage = register(createWorld(), archetype([Place]));
    spawn(storage, { ViewEnumPlace: { x: 1, y: 2 } });

    const snapshots: object[] = [];
    each(storage, (e) => {
      snapshots.push({ ...e.ViewEnumPlace });
      e.ViewEnumPlace.x = 5;
    });

    expect(snapshots).toStrictEqual([{ x: 1, y: 2 }]);
  });

  it("keeps a spread unchanged when the view rebinds to another row", () => {
    const storage = register(createWorld(), archetype([Place]));
    const first = spawn(storage, { ViewEnumPlace: { x: 1, y: 2 } });
    const second = spawn(storage, { ViewEnumPlace: { x: 3, y: 4 } });

    const snapshots = new Map<number, object>();
    each(storage, (e) => {
      snapshots.set(e.id, { ...e.ViewEnumPlace });
    });

    expect(snapshots).toStrictEqual(
      new Map<number, object>([
        [second, { x: 3, y: 4 }],
        [first, { x: 1, y: 2 }],
      ]),
    );
  });

  it.each([{ active: true }, { active: false }])(
    "spreads and serializes boolean field $active as a boolean",
    ({ active }) => {
      const storage = register(createWorld(), archetype([Flag]));
      spawn(storage, { ViewEnumFlag: { active } });

      const seen: unknown[] = [];
      each(storage, (e) => {
        seen.push([{ ...e.ViewEnumFlag }, JSON.stringify(e.ViewEnumFlag)]);
      });

      expect(seen).toStrictEqual([
        [{ active, count: 0 }, `{"active":${String(active)},"count":0}`],
      ]);
    },
  );

  it("exposes an enabled optional data component's fields through its slot", () => {
    const storage = register(createWorld(), archetype([Place], [Shield]));
    spawn(storage, { ViewEnumShield: { hp: 75 } });

    const seen: unknown[] = [];
    each(storage, (e) => {
      seen.push([Object.keys(e.ViewEnumShield ?? {}), { ...e.ViewEnumShield }]);
    });

    expect(seen).toStrictEqual([[["defense", "hp"], { hp: 75, defense: 10 }]]);
  });

  it("lists id and every required and optional slot as keys of the view", () => {
    const storage = register(createWorld(), archetype([Place, Burning], [Shield, Stunned]));
    spawn(storage);

    const seen: string[][] = [];
    each(storage, (e) => {
      seen.push(Object.keys(e).toSorted());
    });

    expect(seen).toStrictEqual([
      ["ViewEnumBurning", "ViewEnumPlace", "ViewEnumShield", "ViewEnumStunned", "id"],
    ]);
  });

  it("serializes id, data fields, and enabled tags, omitting disabled optionals", () => {
    const storage = register(createWorld(), archetype([Place, Burning], [Shield, Stunned]));
    const shielded = spawn(storage, { ViewEnumPlace: { x: 1, y: 2 }, ViewEnumShield: { hp: 75 } });
    const stunned = spawn(storage, { ViewEnumStunned: true });

    const serialized = new Map<number, unknown>();
    each(storage, (e) => {
      serialized.set(e.id, roundTrip(e));
    });

    expect(serialized).toStrictEqual(
      new Map<number, unknown>([
        [
          stunned,
          {
            id: stunned,
            ViewEnumPlace: { x: 0, y: 0 },
            ViewEnumBurning: true,
            ViewEnumStunned: true,
          },
        ],
        [
          shielded,
          {
            id: shielded,
            ViewEnumPlace: { x: 1, y: 2 },
            ViewEnumBurning: true,
            ViewEnumShield: { hp: 75, defense: 10 },
          },
        ],
      ]),
    );
  });

  it("serializes views handed out by query the same way", () => {
    const world = createWorld();
    const id = spawn(register(world, archetype([Place])), { ViewEnumPlace: { x: 1, y: 2 } });

    const seen: unknown[] = [];
    query(world, [Place], (e) => {
      seen.push(roundTrip(e));
    });

    expect(seen).toStrictEqual([{ id, ViewEnumPlace: { x: 1, y: 2 } }]);
  });
});
