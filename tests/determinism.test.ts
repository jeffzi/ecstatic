import { describe, expect, it } from "vitest";

import { entityIndex } from "../src/entity-id.js";
import {
  alive,
  archetype,
  components,
  createWorld,
  despawn,
  disable,
  each,
  enable,
  type EntityId,
  getResource,
  type Storage,
  getSources,
  link,
  query,
  querySources,
  register,
  relation,
  resource,
  setResource,
  spawn,
  spawnMany,
  unlink,
} from "../src/index.js";
import { rowOf } from "./fixtures.js";

function mulberry32(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function declareEcs(suffix: string) {
  const Position = components({ [`DetPos${suffix}`]: { x: 0, y: 0 } })[`DetPos${suffix}`]!;
  const Velocity = components({ [`DetVel${suffix}`]: { vx: 0, vy: 0 } })[`DetVel${suffix}`]!;
  const Tag = components({ [`DetTag${suffix}`]: {} })[`DetTag${suffix}`]!;
  const Owns = relation(`DetOwns${suffix}`);
  const Score = resource(`DetScore${suffix}`, { value: 0 });

  const PosVelArch = archetype([Position, Velocity], [Tag]);
  const OwnedArch = archetype([Position], [Owns]);
  const SimpleArch = archetype([Position]);

  return { Position, Velocity, Tag, Owns, Score, PosVelArch, OwnedArch, SimpleArch };
}

interface Trace {
  spawnedIds: EntityId[];
  spawnManyIds: number[];
  eachOrder: number[];
  queryOrder: number[];
  querySourcesOrder: number[];
  getSourcesResult: number[];
  aliveResults: boolean[];
  resourceValue: number;
}

function runOpScript(suffix: string, seed: number): Trace {
  const { Position, Tag, Owns, Score, PosVelArch, OwnedArch, SimpleArch } = declareEcs(suffix);

  const world = createWorld();
  const pvStorage: Storage = register(world, PosVelArch);
  const ownedStorage = register(world, OwnedArch);
  const simpleStorage = register(world, SimpleArch);
  const rng = mulberry32(seed);

  const trace: Trace = {
    spawnedIds: [],
    spawnManyIds: [],
    eachOrder: [],
    queryOrder: [],
    querySourcesOrder: [],
    getSourcesResult: [],
    aliveResults: [],
    resourceValue: 0,
  };

  // Phase 1: spawn entities with seeded positions
  for (let i = 0; i < 8; i++) {
    const x = Math.floor(rng() * 100);
    const y = Math.floor(rng() * 100);
    const id = spawn(pvStorage, {
      [`DetPos${suffix}`]: { x, y },
      [`DetVel${suffix}`]: { vx: x + 1, vy: y + 1 },
    });
    trace.spawnedIds.push(id);
  }

  // Phase 2: spawnMany
  const batchIds = spawnMany(pvStorage, 4);
  trace.spawnManyIds.push(...batchIds);

  // Phase 3: despawn some entities (seeded selection)
  const despawnCount = 3;
  for (let i = 0; i < despawnCount; i++) {
    const idx = Math.floor(rng() * trace.spawnedIds.length);
    const id = trace.spawnedIds[idx]!;
    if (alive(pvStorage, id)) {
      despawn(pvStorage, id);
    }
  }

  // Phase 4: enable/disable optional tag on remaining entities
  each(pvStorage, (e) => {
    if (rng() > 0.5) {
      enable(pvStorage, e.id, Tag);
    }
  });
  each(pvStorage, (e) => {
    if (rng() > 0.7) {
      disable(pvStorage, e.id, Tag);
    }
  });

  // Phase 5: spawn targets and link/unlink (Owns is optional)
  const target1 = spawn(simpleStorage);
  const target2 = spawn(simpleStorage);
  const owned1 = spawn(ownedStorage);
  const owned2 = spawn(ownedStorage);
  const owned3 = spawn(ownedStorage);

  link(world, owned1, Owns, target1);
  link(world, owned2, Owns, target1);
  link(world, owned3, Owns, target2);

  // Retarget owned2 from target1 to target2
  link(world, owned2, Owns, target2);
  // Unlink owned3
  unlink(world, owned3, Owns);

  // Phase 6: resource set
  setResource(world, Score, { value: 42 });

  // ---- Record trace ----

  // each order
  each(pvStorage, (e) => {
    trace.eachOrder.push(e.id);
  });

  // query order (across all storages with Position)
  query(world, [Position], (e) => {
    trace.queryOrder.push(e.id);
  });

  // querySources order
  querySources(world, Owns, target2, (e) => {
    trace.querySourcesOrder.push(e.id);
  });

  // getSources
  trace.getSourcesResult = [...getSources(world, Owns, target1)];

  // alive results for all originally spawned IDs
  for (const id of trace.spawnedIds) {
    trace.aliveResults.push(alive(pvStorage, id));
  }

  // resource
  trace.resourceValue = getResource(world, Score).value;

  return trace;
}

describe("determinism", () => {
  describe("replay produces identical traces", () => {
    it("two independent worlds with the same op script yield identical traces", () => {
      const seed = 12345;
      const traceA = runOpScript("A", seed);
      const traceB = runOpScript("B", seed);

      expect(traceA.spawnedIds).toStrictEqual(traceB.spawnedIds);
      expect(traceA.spawnManyIds).toStrictEqual(traceB.spawnManyIds);
      expect(traceA.eachOrder).toStrictEqual(traceB.eachOrder);
      expect(traceA.queryOrder).toStrictEqual(traceB.queryOrder);
      expect(traceA.querySourcesOrder).toStrictEqual(traceB.querySourcesOrder);
      expect(traceA.getSourcesResult).toStrictEqual(traceB.getSourcesResult);
      expect(traceA.aliveResults).toStrictEqual(traceB.aliveResults);
      expect(traceA.resourceValue).toBe(traceB.resourceValue);
    });

    it("traces are non-trivial (entities were actually spawned, despawned, and visited)", () => {
      const trace = runOpScript("C", 12345);

      expect(trace.spawnedIds.length).toBe(8);
      expect(trace.spawnManyIds.length).toBe(4);
      expect(trace.eachOrder.length).toBeGreaterThan(0);
      expect(trace.queryOrder.length).toBeGreaterThan(0);
      // Some entities were despawned
      expect(trace.aliveResults.filter((a) => !a).length).toBeGreaterThan(0);
      expect(trace.resourceValue).toBe(42);
    });
  });

  describe("order spec pinned", () => {
    it("each visits rows last-to-first", () => {
      const { DetPosOrder: Position } = components({
        DetPosOrder: { x: 0, y: 0 },
      });
      const Arch = archetype([Position]);
      const world = createWorld();
      const storage = register(world, Arch);

      const id0 = spawn(storage);
      const id1 = spawn(storage);
      const id2 = spawn(storage);

      const visited: number[] = [];
      each(storage, (e) => {
        visited.push(e.id);
      });

      // Backward: last spawned first
      expect(visited).toStrictEqual([id2, id1, id0]);
    });

    it("despawning a middle entity swaps the last entity into that row", () => {
      const { DetPosSwap: Position } = components({
        DetPosSwap: { x: 0, y: 0 },
      });
      const Arch = archetype([Position]);
      const world = createWorld();
      const storage = register(world, Arch);

      const id0 = spawn(storage, { DetPosSwap: { x: 0, y: 0 } });
      const id1 = spawn(storage, { DetPosSwap: { x: 10, y: 10 } });
      const id2 = spawn(storage, { DetPosSwap: { x: 20, y: 20 } });

      // Despawn the middle entity (index 1) -- last entity (id2) swaps in
      despawn(storage, id1);

      // After swap-and-pop: [id0, id2], n=2
      expect(storage.n).toBe(2);
      expect(storage.entities[0]).toBe(id0);
      expect(storage.entities[1]).toBe(id2);

      // The formerly-last entity (id2) now occupies row 1 (the despawned row)
      expect(rowOf(storage, id2)).toBe(1);

      // Verify data was swapped: row 1 should have id2's data (20, 20)
      const pos = storage.columns.get(Position)!;
      expect(pos.x![1]).toBe(20);
      expect(pos.y![1]).toBe(20);

      // each visits backward: id2 (row 1) then id0 (row 0)
      const visited: number[] = [];
      each(storage, (e) => {
        visited.push(e.id);
      });
      expect(visited).toStrictEqual([id2, id0]);
    });

    it("next spawn after despawn reuses the freed index with incremented generation", () => {
      const { DetPosReuse: Position } = components({
        DetPosReuse: { x: 0, y: 0 },
      });
      const Arch = archetype([Position]);
      const world = createWorld();
      const storage = register(world, Arch);

      spawn(storage);
      const id1 = spawn(storage);
      spawn(storage);

      despawn(storage, id1);

      // Next spawn should reuse the index that id1 occupied (the last entity
      // swapped into row 1, so the freed slot on the free list is id2's
      // original index before it was swapped -- but the free list tracks the
      // entity index, not the row). The recycled ID shares the same entity
      // index as id1 but with incremented generation.
      const reused = spawn(storage);

      // The reused entity shares id1's index
      expect(entityIndex(reused)).toBe(entityIndex(id1));

      // But it has a different (higher) generation, so it's a different ID
      expect(reused).not.toBe(id1);

      // The old id1 is no longer alive
      expect(alive(storage, id1)).toBe(false);
      expect(alive(storage, reused)).toBe(true);
    });
  });
});
