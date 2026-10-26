import { describe, expect, it } from "vitest";

import {
  archetype,
  components,
  createWorld,
  despawn,
  each,
  type EntityId,
  enable,
  enableMany,
  get,
  getSources,
  getTarget,
  has,
  link,
  register,
  relation,
  set,
  spawn,
  type Storage,
} from "../../../src/ecstatic/index.js";

const { FindPos: Position, FindShield: Shield } = components({
  FindPos: { x: 0, y: 0 },
  FindShield: { hp: 50 },
});
const FindRel = relation("FindRel", [], { weight: 0 });
const FindRelB = relation("FindRelB", [], { weight: 0 });

/**
 * A storage holding `victim` and `bystander` where despawning `victim` leaves its sparse slot
 * pointing at the bystander's row: a write that resolves the victim's row after a getter
 * despawned it lands on the bystander.
 */
function createVictim() {
  const world = createWorld();
  const storage = register(world, archetype([Position, FindRel], [Shield]));
  const target = spawn(register(world, archetype([Position])));
  const first = spawn(storage, { FindRel: { target } });
  const bystander = spawn(storage, { FindRel: { target } });
  const victim = spawn(storage, { FindRel: { target } });
  despawn(storage, first);
  return { world, storage, target, bystander, victim };
}

/** Values whose `field` getter despawns `id` itself, then returns 99. */
function selfDespawn(storage: Storage, id: EntityId, field: string): Record<string, number> {
  return {
    get [field](): number {
      despawn(storage, id);
      return 99;
    },
  };
}

describe("a getter that despawns the entity being written", () => {
  it.each([
    {
      form: "enable",
      apply: (s: Storage, id: EntityId) => {
        enable(s, id, Shield, selfDespawn(s, id, "hp"));
      },
    },
    {
      form: "enable record",
      apply: (s: Storage, id: EntityId) => {
        enable(s, id, { FindShield: selfDespawn(s, id, "hp") });
      },
    },
    {
      form: "enableMany",
      apply: (s: Storage, id: EntityId) => {
        enableMany(s, [id], { FindShield: selfDespawn(s, id, "hp") });
      },
    },
    {
      form: "set record",
      apply: (s: Storage, id: EntityId) => {
        set(s, id, Position, selfDespawn(s, id, "x"));
      },
    },
  ])("$form throws and leaves the other entity's row alone #checked", ({ apply }) => {
    const { storage, bystander, victim } = createVictim();
    enable(storage, bystander, Shield, { hp: 7 });

    expect(() => {
      apply(storage, victim);
    }).toThrow("stale entity ID");
    expect(get(storage, bystander, Position.x)).toBe(0);
    expect(get(storage, bystander, Shield.hp)).toBe(7);
  });

  it("link throws and leaves the other entity's row and the reverse map alone #checked", () => {
    const { world, storage, target, bystander, victim } = createVictim();

    expect(() => {
      link(world, victim, FindRel, target, selfDespawn(storage, victim, "weight"));
    }).toThrow("stale entity ID");
    expect(get(storage, bystander, FindRel.weight)).toBe(0);
    expect(getSources(world, FindRel, target)).toStrictEqual([bystander]);
  });
});

describe("a getter that despawns the link target", () => {
  it("link throws and leaves the source linked to its old target #checked", () => {
    const world = createWorld();
    const storage = register(world, archetype([Position], [FindRel]));
    const targets = register(world, archetype([Position]));
    const oldTarget = spawn(targets);
    const newTarget = spawn(targets);
    const source = spawn(storage);
    link(world, source, FindRel, oldTarget);
    const values = {
      get weight(): number {
        despawn(targets, newTarget);
        return 3;
      },
    };

    expect(() => {
      link(world, source, FindRel, newTarget, values);
    }).toThrow("stale target ID for relation FindRel");
    expect(getTarget(world, source, FindRel)).toBe(oldTarget);
  });

  it("spawn throws and spawns nothing when a later relation getter despawns an earlier target #checked", () => {
    const world = createWorld();
    const storage = register(world, archetype([Position, FindRel, FindRelB]));
    const targets = register(world, archetype([Position]));
    const first = spawn(targets);
    const second = spawn(targets);

    expect(() => {
      spawn(storage, {
        FindRel: { target: first },
        FindRelB: {
          target: second,
          get weight(): number {
            despawn(targets, first);
            return 1;
          },
        },
      });
    }).toThrow("stale target ID for relation FindRel");
    expect(storage.n).toBe(0);
    expect(getSources(world, FindRelB, second)).toStrictEqual([]);
  });
});

describe("enableMany values getter that throws on a later row", () => {
  it("sets no presence bit, so the mask and the matcher caches agree", () => {
    const world = createWorld();
    const storage = register(world, archetype([Position], [Shield]));
    const first = spawn(storage);
    const second = spawn(storage);
    each(storage, { all: [Shield] }, () => {});
    let reads = 0;
    const values = {
      get hp(): number {
        reads += 1;
        if (reads === 2) {
          throw new Error("banana");
        }
        return 75;
      },
    };

    expect(() => {
      enableMany(storage, [first, second], { FindShield: values });
    }).toThrow("banana");
    const matched: number[] = [];
    each(storage, { all: [Shield] }, (e) => {
      matched.push(e.id);
    });
    expect(has(storage, first, Shield)).toBe(false);
    expect(matched).toStrictEqual([]);
  });
});
