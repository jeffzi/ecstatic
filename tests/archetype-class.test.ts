import { describe, expect, it } from "vitest";

import {
  Archetype,
  archetype,
  components,
  createWorld,
  despawn,
  each,
  getStorage,
  register,
  spawn,
} from "../src/index.js";

const { ArchClass_Position: Position } = components({ ArchClass_Position: { x: 0, y: 0 } });
const { ArchClass_Health: Health } = components({ ArchClass_Health: { hp: 100 } });
const { ArchClass_Frozen: Frozen } = components({ ArchClass_Frozen: {} });
const { ArchClass_Cannon: Cannon } = components({ ArchClass_Cannon: { power: 1 } });

class Ship extends Archetype([Position, Health], [Frozen]) {}

/**
 * Archetype-class constructors take one `never` parameter, so `new Ship()` is a
 * compile error. A caller can still cast past that guard; this produces the
 * argument such a caller would pass, so the runtime guard stays exercised.
 */
const circumventCompileTimeGuard = (): never => undefined as never;

describe("Archetype", () => {
  describe("when an archetype class is constructed", () => {
    it.each([
      {
        form: "the factory return",
        construct: (): unknown => new (Archetype([Position]))(circumventCompileTimeGuard()),
      },
      {
        form: "a declared subclass",
        construct: (): unknown => new Ship(circumventCompileTimeGuard()),
      },
    ])("throws for $form", ({ construct }) => {
      expect(construct).toThrow(/archetype classes are declarations/);
    });
  });

  describe("when the component lists are invalid", () => {
    it("propagates the archetype validation error", () => {
      expect(() => Archetype([Position, Position])).toThrow(/duplicate component/);
    });
  });

  describe("when a declaration exposes its component lists", () => {
    it.each([
      { form: "the factory return", declaration: Archetype([Position, Health], [Frozen]) },
      { form: "a declared subclass", declaration: Ship },
    ])("exposes the declared lists on $form", ({ declaration }) => {
      expect(declaration.components).toStrictEqual([Position, Health]);
      expect(declaration.optionals).toStrictEqual([Frozen]);
    });

    it("shares the tuples of the canonical descriptor", () => {
      const canonical = archetype([Position, Health], [Frozen]);

      expect(Ship.components).toBe(canonical.components);
      expect(Ship.optionals).toBe(canonical.optionals);
    });
  });

  describe("when the lists of a declared class are spread into a new declaration", () => {
    it("declares the composed archetype", () => {
      const world = createWorld();
      class Tank extends Archetype([...Ship.components, Cannon], [...Ship.optionals]) {}
      const composed = register(world, archetype([Position, Health, Cannon], [Frozen]));

      const tanks = register(world, Tank);

      expect(tanks).toBe(composed);
    });
  });
});

describe("register", () => {
  describe("when given an archetype class", () => {
    it("iterates entities spawned into the returned storage", () => {
      const world = createWorld();
      const ships = register(world, Ship);
      spawn(ships, { ArchClass_Position: { x: 3 } });

      const seen: number[] = [];
      each(ships, (e) => {
        seen.push(e.ArchClass_Position.x);
      });

      expect(seen).toStrictEqual([3]);
    });

    it("despawns entities from the returned storage", () => {
      const world = createWorld();
      const ships = register(world, Ship);
      const id = spawn(ships);

      despawn(ships, id);

      expect(ships.n).toBe(0);
    });

    it("returns the same storage when the class is registered twice", () => {
      const world = createWorld();
      const first = register(world, Ship);

      const second = register(world, Ship);

      expect(second).toBe(first);
    });

    it("resolves two classes over the same components to the same storage", () => {
      const world = createWorld();
      class A extends Archetype([Position]) {}
      class B extends Archetype([Position]) {}
      const storageA = register(world, A);
      spawn(storageA, { ArchClass_Position: { x: 1, y: 2 } });

      const storageB = register(world, B);

      expect(storageB).toBe(storageA);
      expect(storageB.n).toBe(1);
    });

    it("returns the storage of the equivalent descriptor form", () => {
      const world = createWorld();
      const fromClass = register(world, Ship);

      const fromDescriptor = register(world, archetype([Position, Health], [Frozen]));

      expect(fromDescriptor).toBe(fromClass);
    });
  });

  describe("when given an archetype declaration that is not a direct subclass", () => {
    it("throws on a factory return that was never subclassed", () => {
      const world = createWorld();
      const Bare = Archetype([Position]);

      expect(() => register(world, Bare)).toThrow(/Archetype\(\) result must be subclassed/);
    });

    it("throws on a subclass of a declared archetype class", () => {
      const world = createWorld();
      class Boat extends Ship {}

      expect(() => register(world, Boat)).toThrow(/must extend Archetype\(\) directly/);
    });
  });
});

describe("getStorage", () => {
  describe("when given an archetype class", () => {
    it("returns the storage registered from that class", () => {
      const world = createWorld();
      const ships = register(world, Ship);

      const retrieved = getStorage(world, Ship);

      expect(retrieved).toBe(ships);
    });
  });
});
