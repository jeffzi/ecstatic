import { describe, it } from "vitest";

import {
  archetype,
  createWorld,
  type EntityId,
  register,
  relation,
  spawn,
  spawnMany,
  type Storage,
} from "../../../src/index.js";
import { Health, Position } from "../_fixtures.js";

const ReqRel = relation("SpawnRelType_Req", [Position]);
const OptRel = relation("SpawnRelType_Opt", [Position], { weight: 0 });
const FreeRel = relation("SpawnRelType_Free");

const world = createWorld();
const targets = register(world, archetype([Position]));
const nonTargets = register(world, archetype([Health]));
const reqStorage = register(world, archetype([Health, ReqRel]));
const optStorage = register(world, archetype([Health], [OptRel]));
const freeStorage = register(world, archetype([Health, FreeRel]));

declare const bareStorage: Storage;
declare const plainId: EntityId;

const target = spawn(targets);
const nonTarget = spawn(nonTargets);

describe("spawn with required relations", () => {
  it("requires the relation key and the target object form", () => {
    spawn(reqStorage, { SpawnRelType_Req: { target } });

    // @ts-expect-error a required relation must receive a target at spawn
    spawn(reqStorage);
    // @ts-expect-error the required relation key cannot be omitted
    spawn(reqStorage, {});
    // @ts-expect-error true is not a valid required-relation override
    spawn(reqStorage, { SpawnRelType_Req: true });
    // @ts-expect-error false is not a valid required-relation override
    spawn(reqStorage, { SpawnRelType_Req: false });
    // @ts-expect-error a record without target is not a valid relation override
    spawn(reqStorage, { SpawnRelType_Req: {} });
  });

  it("rejects a target that does not satisfy the constraints", () => {
    // @ts-expect-error the target archetype lacks Position
    spawn(reqStorage, { SpawnRelType_Req: { target: nonTarget } });
    // @ts-expect-error a plain EntityId carries no presence map
    spawn(reqStorage, { SpawnRelType_Req: { target: plainId } });
    // @ts-expect-error a raw number is not an EntityId
    spawn(reqStorage, { SpawnRelType_Req: { target: 42 } });
  });

  it("an unconstrained relation admits every EntityId", () => {
    spawn(freeStorage, { SpawnRelType_Free: { target } });
    spawn(freeStorage, { SpawnRelType_Free: { target: nonTarget } });
    spawn(freeStorage, { SpawnRelType_Free: { target: plainId } });
  });
});

describe("spawn with optional relations", () => {
  it("accepts the target object form, false, or omission", () => {
    spawn(optStorage);
    spawn(optStorage, {});
    spawn(optStorage, { SpawnRelType_Opt: false });
    spawn(optStorage, { SpawnRelType_Opt: { target } });
    spawn(optStorage, { SpawnRelType_Opt: { target, weight: 2 } });
  });

  it("rejects true and records without target", () => {
    // @ts-expect-error true cannot birth-link an optional relation
    spawn(optStorage, { SpawnRelType_Opt: true });
    // @ts-expect-error a record without target is not a valid relation override
    spawn(optStorage, { SpawnRelType_Opt: { weight: 2 } });
    // @ts-expect-error the target archetype lacks Position
    spawn(optStorage, { SpawnRelType_Opt: { target: nonTarget } });
  });
});

describe("spawnMany with relations", () => {
  it("applies the same grammar as spawn", () => {
    spawnMany(reqStorage, 3, { SpawnRelType_Req: { target } });
    spawnMany(optStorage, 3, { SpawnRelType_Opt: { target } });

    // @ts-expect-error a required relation must receive a target at spawn
    spawnMany(reqStorage, 3);
    // @ts-expect-error the out form cannot satisfy a required relation
    spawnMany(reqStorage, 3, []);
    // @ts-expect-error true is not a valid required-relation override
    spawnMany(reqStorage, 3, { SpawnRelType_Req: true });
  });
});

describe("untyped storage spawns", () => {
  it("keeps the loose record grammar", () => {
    spawn(bareStorage);
    spawn(bareStorage, { Anything: { target: 42 } });
    spawnMany(bareStorage, 2, { Anything: true });
    spawnMany(bareStorage, 2, []);
  });
});
