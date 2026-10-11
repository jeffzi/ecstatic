import { describe, it } from "vitest";

import type { Storage } from "../../../src/index.js";
import {
  archetype,
  createWorld,
  disable,
  disableMany,
  enable,
  enableMany,
  has,
  register,
  relation,
  spawn,
} from "../../../src/index.js";
import { Health, Position, Shield, Stunned } from "../_fixtures.js";

describe("enable/disable typing", () => {
  const world = createWorld();
  const storage = register(world, archetype([Position], [Shield, Stunned]));
  const id = spawn(storage);

  it("accepts optional components and types the values param", () => {
    enable(storage, id, Shield);
    enable(storage, id, Shield, { hp: 75 });
    enable(storage, id, Stunned);
    disable(storage, id, Shield);
    disable(storage, id, [Shield, Stunned]);
  });

  it("rejects unknown fields and wrong value types in values", () => {
    // @ts-expect-error "wrong" is not a field of Shield
    enable(storage, id, Shield, { wrong: 1 });
    // @ts-expect-error string is not assignable to number
    enable(storage, id, Shield, { hp: "oops" });
  });

  it("rejects relations with the link/unlink sentence error", () => {
    const Rel = relation("EnDisTd_Rel");
    const relStorage = register(world, archetype([Position], [Rel]));
    const relId = spawn(relStorage);
    // @ts-expect-error relations are toggled via link()/unlink()
    enable(relStorage, relId, Rel);
    // @ts-expect-error relations are toggled via link()/unlink()
    disable(relStorage, relId, Rel);
    // @ts-expect-error relations are toggled via link()/unlink()
    has(relStorage, relId, Rel);
  });

  it("rejects a relation in the record form", () => {
    const Rel = relation("EnDisTd_RecRel");
    const relStorage = register(world, archetype([Position], [Shield, Rel]));
    const relId = spawn(relStorage);
    // @ts-expect-error relations are toggled via link()/unlink()
    enable(relStorage, relId, { EnDisTd_RecRel: true });
    // @ts-expect-error relations are toggled via link()/unlink()
    disable(relStorage, relId, { EnDisTd_RecRel: true });
    void relId;
  });

  it("rejects a relation in the array disable form", () => {
    const Rel = relation("EnDisTd_ArrRel");
    const relStorage = register(world, archetype([Position], [Shield, Rel]));
    const relId = spawn(relStorage);
    // @ts-expect-error relations are toggled via link()/unlink()
    disable(relStorage, relId, [Rel]);
    void relId;
  });

  it("rejects required and off-archetype components with sentence errors", () => {
    // @ts-expect-error Position is required, not optional
    enable(storage, id, Position);
    // @ts-expect-error Health is not on this archetype
    enable(storage, id, Health);
    // @ts-expect-error Position is required, not optional
    disable(storage, id, Position);
    // @ts-expect-error Health is not on this archetype
    disable(storage, id, [Health]);
  });

  it("accepts the record form with the tag/data grammar", () => {
    enable(storage, id, { Shield: { hp: 75 }, Stunned: true });
    enable(storage, id, { Stunned: false });
    // @ts-expect-error tag optionals carry no fields — records are rejected
    enable(storage, id, { Stunned: {} });
    // @ts-expect-error Health is not an optional on this archetype
    enable(storage, id, { Health: true });
  });

  it("makes the record form uncallable on a no-optionals storage", () => {
    const bare = register(world, archetype([Position]));
    const bareId = spawn(bare);
    // @ts-expect-error this archetype declares no optionals
    enable(bare, bareId, { Shield: true });
  });

  it("rejects the empty tuple in the array disable form", () => {
    // @ts-expect-error at least one component is required
    disable(storage, id, []);
  });

  it("falls back to accepting any component on a bare storage", () => {
    const bare: Storage = storage;
    enable(bare, id, Health);
    enable(bare, id, Health, { hp: 1 });
    disable(bare, id, Health);
  });

  it("leaves world forms type-unvalidated", () => {
    enable(world, id, Health, { hp: 1 });
    enable(world, id, { Health: true });
    disable(world, id, Health);
    disable(world, id, [Health, Position]);
  });
});

describe("enableMany/disableMany typing", () => {
  const world = createWorld();
  const storage = register(world, archetype([Position], [Shield, Stunned]));
  const id = spawn(storage);

  it("accepts both arities with the record/array grammar", () => {
    enableMany(storage, [id], { Shield: { hp: 75 }, Stunned: true });
    enableMany(storage, { Stunned: false });
    disableMany(storage, [id], [Shield, Stunned]);
    disableMany(storage, [Shield]);
  });

  it("rejects invalid records and component lists", () => {
    // @ts-expect-error Health is not an optional on this archetype
    enableMany(storage, [id], { Health: true });
    // @ts-expect-error tag optionals carry no fields — records are rejected
    enableMany(storage, { Stunned: {} });
    // @ts-expect-error Position is required, not optional
    disableMany(storage, [id], [Position]);
    // @ts-expect-error Health is not on this archetype
    disableMany(storage, [Health]);
  });

  it("rejects a relation in the record form", () => {
    const Rel = relation("EnDisManyTd_Rel");
    const relStorage = register(world, archetype([Position], [Shield, Rel]));
    const relId = spawn(relStorage);
    // @ts-expect-error relations are toggled via link()/unlink()
    enableMany(relStorage, [relId], { EnDisManyTd_Rel: true });
    // @ts-expect-error relations are toggled via link()/unlink()
    disableMany(relStorage, [relId], [Rel]);
  });

  it("rejects the empty tuple in disableMany", () => {
    // @ts-expect-error at least one component is required
    disableMany(storage, [id], []);
    // @ts-expect-error at least one component is required
    disableMany(storage, []);
  });

  it("makes the record form uncallable on a no-optionals storage", () => {
    const bare = register(world, archetype([Position]));
    const bareId = spawn(bare);
    // @ts-expect-error this archetype declares no optionals
    enableMany(bare, [bareId], { Shield: true });
  });
});
