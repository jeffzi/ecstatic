import { assert, describe, expect, it } from "vitest";

import { archetype } from "../src/archetype.js";
import { component, components, isComponentDescriptor, ref } from "../src/component.js";
import { type EntityId, entityIndex } from "../src/entity-id.js";
import { get, getTarget } from "../src/entity/access.js";
import { alive } from "../src/entity/common.js";
import { despawn } from "../src/entity/despawn.js";
import { each } from "../src/entity/each.js";
import { link, unlink } from "../src/entity/relation.js";
import { reverseInsert, reverseRemove, sourceBucket } from "../src/entity/reverse-map.js";
import { spawn, spawnMany } from "../src/entity/spawn.js";
import { getRelationMeta, relation } from "../src/relation.js";
import type { World } from "../src/world.js";
import { createWorld, destroyWorld, register } from "../src/world.js";
import { asMutableDescriptor, type DescriptorView, rowOf } from "./fixtures.js";

/** Source entity indices currently recorded for a relation target (reverse-map view). */
function sourceIndices(world: World, rel: unknown, targetId: number): number[] {
  const meta = getRelationMeta(rel);
  if (meta === undefined) {
    throw new Error("expected a relation descriptor");
  }
  const relMap = world.reverseMap.get(meta);
  const bucket = relMap === undefined ? undefined : sourceBucket(relMap, entityIndex(targetId));
  return bucket === undefined ? [] : [...bucket.keys()];
}

/** Relation-specific extension of {@link DescriptorView} for descriptor-internal assertions. */
interface RelationDescriptorView extends DescriptorView {
  isRelation: boolean;
  constraints: unknown[];
}

/** Casts a relation descriptor to a mutable {@link RelationDescriptorView}, throwing otherwise. */
function rmd(v: unknown): RelationDescriptorView {
  const base = asMutableDescriptor(v);
  if ("isRelation" in base && "constraints" in base) {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- isRelation + constraints presence checked above
    return base as RelationDescriptorView;
  }
  throw new Error(`Expected RelationDescriptorView (isRelation + constraints), got ${typeof v}`);
}

const { RelSpec_Comp } = components({ RelSpec_Comp: { x: 0, y: 0 } });

describe("relation", () => {
  it("returns a descriptor object with isRelation true", () => {
    const Owner = relation("RelSpec_Owner");
    expect(typeof Owner).toBe("object");
    expect(rmd(Owner).isRelation).toBe(true);
  });

  it("stores name, fields, and defaults for tag-like relation", () => {
    const Link = relation("RelSpec_Link");
    const meta = asMutableDescriptor(Link);
    expect(meta.__ecstatic_name).toBe("RelSpec_Link");
    expect(meta.__ecstatic_fields.length).toBe(0);
    expect(typeof meta.__ecstatic_defaults).toBe("object");
  });

  it("stores constraints array of component descriptors", () => {
    const meta = rmd(relation("RelSpec_Attached", [RelSpec_Comp]));
    expect(Array.isArray(meta.constraints)).toBe(true);
    expect(meta.constraints[0]).toBe(RelSpec_Comp);
  });

  it("stores both constraints and fields for data-carrying constrained relation", () => {
    const Attached = relation("RelSpec_AttachedData", [RelSpec_Comp], {
      offset: 0,
    });
    const meta = rmd(Attached);
    expect(Array.isArray(meta.constraints)).toBe(true);
    expect(meta.constraints[0]).toBe(RelSpec_Comp);
    expect(meta.__ecstatic_fields).toStrictEqual(["offset"]);
    expect(meta.__ecstatic_defaults).toStrictEqual({ offset: 0 });
  });

  it("stores empty constraints for unconstrained relation", () => {
    const meta = rmd(relation("RelSpec_Unconstrained"));
    expect(Array.isArray(meta.constraints)).toBe(true);
    expect(meta.constraints.length).toBe(0);
  });

  it("stores empty fields for tag-like relation with no data", () => {
    const PureNoData = relation("RelSpec_PureNoData");
    expect(rmd(PureNoData).__ecstatic_fields.length).toBe(0);
  });

  it("data-only form relation(name, {}) vs (name, []) are equivalent", () => {
    const EmptyDefaults = relation("DataOnlyRelSpec_EmptyDefaults", {});
    const PureLink = relation("DataOnlyRelSpec_PureLink");

    expect(rmd(EmptyDefaults).__ecstatic_fields.length).toBe(0);
    expect(rmd(PureLink).__ecstatic_fields.length).toBe(0);
    expect(rmd(EmptyDefaults).constraints.length).toBe(0);
    expect(rmd(PureLink).constraints.length).toBe(0);
  });

  it("is also a valid component descriptor", () => {
    const PureFields = relation("RelSpec_PureFields");
    expect(asMutableDescriptor(PureFields).__ecstatic_name).toBe("RelSpec_PureFields");
    expect(isComponentDescriptor(PureFields)).toBe(true);
  });

  it("attaches a synthetic target field descriptor", () => {
    const Owner = relation("RelSpec_TargetDescriptor");
    expect(Owner.target.__ecstatic_component).toBe(Owner);
    expect(Owner.target.__ecstatic_field).toBe("target");
  });

  it("errors when field named target declared", () => {
    expect(() => {
      // @ts-expect-error target is a reserved relation field name
      relation("RelSpec_TargetField", [], { target: 0 });
    }).toThrow("relation field name 'target' is reserved: RelSpec_TargetField");
  });

  it("errors when field named target declared in data-only form", () => {
    expect(() => {
      // @ts-expect-error target is a reserved relation field name
      relation("DataOnlyRelSpec_ReservedTarget", { target: 0 });
    }).toThrow("relation field name 'target' is reserved: DataOnlyRelSpec_ReservedTarget");
  });

  it("throws on shape conflict when re-declared with different fields", () => {
    relation("RelSpec_DupName");
    expect(() => {
      relation("RelSpec_DupName", { weight: 0 });
    }).toThrow("component shape conflict: RelSpec_DupName");
  });

  it("errors when relation name collides with existing component name", () => {
    components({ RelSpec_SharedNs: { val: 0 } });
    expect(() => {
      relation("RelSpec_SharedNs");
    }).toThrow("component shape conflict: RelSpec_SharedNs");
  });

  it("errors when component name collides with existing relation name", () => {
    relation("RelSpec_SharedNsReverse");
    expect(() => {
      component("RelSpec_SharedNsReverse");
    }).toThrow("component shape conflict: RelSpec_SharedNsReverse");
  });

  it("does not register the name when the target-reserved error throws", () => {
    expect(() => {
      // @ts-expect-error target is a reserved relation field name
      relation("RelSpec_TargetNoRegister", { target: 0 });
    }).toThrow(/reserved/);
    // The failed call must not have claimed the name
    relation("RelSpec_TargetNoRegister");
  });
});

describe("idempotent relation registration", () => {
  it("returns the identical descriptor when tag relation re-declared", () => {
    const first = relation("IdempotentRelSpec_Tag");
    const second = relation("IdempotentRelSpec_Tag");
    expect(second).toBe(first);
  });

  it("returns the identical descriptor when data relation re-declared with equal shape", () => {
    const first = relation("IdempotentRelSpec_Data", { weight: 0 });
    const second = relation("IdempotentRelSpec_Data", { weight: 0 });
    expect(second).toBe(first);
  });

  it("returns the identical descriptor when constrained relation re-declared", () => {
    const first = relation("IdempotentRelSpec_Constrained", [RelSpec_Comp]);
    const second = relation("IdempotentRelSpec_Constrained", [RelSpec_Comp]);
    expect(second).toBe(first);
  });

  it("returns the identical descriptor when constrained data relation re-declared", () => {
    const first = relation("IdempotentRelSpec_Full", [RelSpec_Comp], { weight: 0 });
    const second = relation("IdempotentRelSpec_Full", [RelSpec_Comp], { weight: 0 });
    expect(second).toBe(first);
  });

  it("throws on shape conflict when constraint lists differ", () => {
    const { IdempotentRelSpec_C1, IdempotentRelSpec_C2 } = components({
      IdempotentRelSpec_C1: { a: 0 },
      IdempotentRelSpec_C2: { b: 0 },
    });
    relation("IdempotentRelSpec_ConstraintConflict", [IdempotentRelSpec_C1]);
    expect(() => {
      relation("IdempotentRelSpec_ConstraintConflict", [IdempotentRelSpec_C2]);
    }).toThrow("component shape conflict: IdempotentRelSpec_ConstraintConflict");
  });

  it("throws on shape conflict when relation fields differ", () => {
    relation("IdempotentRelSpec_FieldConflict", { weight: 0 });
    expect(() => {
      relation("IdempotentRelSpec_FieldConflict", { speed: 0 });
    }).toThrow("component shape conflict: IdempotentRelSpec_FieldConflict");
  });
});

describe("registering relation archetypes", () => {
  it("records the relation in the world and pre-initializes its reverse-map entry", () => {
    const Owner = relation("RegRelSpec_Owner");
    const world = createWorld();
    const storage = register(world, archetype([RelSpec_Comp, Owner]));

    expect(world.relations).toContain(getRelationMeta(Owner));
    const ownerMeta = getRelationMeta(Owner);
    assert(ownerMeta != null);
    expect(world.reverseMap.has(ownerMeta)).toBe(true);
    expect(world.hasAnyRelations).toBe(true);
    expect(storage.hasRelations).toBe(true);
  });

  it("dedupes a relation shared by two archetypes", () => {
    const Owner = relation("RegRelSpec_Shared");
    const { RegRelSpec_A, RegRelSpec_B } = components({
      RegRelSpec_A: { x: 0 },
      RegRelSpec_B: { y: 0 },
    });
    const world = createWorld();
    register(world, archetype([RegRelSpec_A, Owner]));
    register(world, archetype([RegRelSpec_B, Owner]));

    expect(world.relations.filter((r) => r === getRelationMeta(Owner)).length).toBe(1);
  });

  it("creates a target column for a pure-link optional relation", () => {
    const PureOpt = relation("RegRelSpec_PureOpt");
    const world = createWorld();
    const storage = register(world, archetype([RelSpec_Comp], [PureOpt]));

    const pureOptMeta = getRelationMeta(PureOpt);
    assert(pureOptMeta != null);
    const soa = storage.columns.get(pureOptMeta);
    expect(soa).toBeDefined();
    expect(soa?.target).toBeDefined();
  });

  it("leaves relation state empty for relation-free archetypes", () => {
    const { RegRelSpec_Plain } = components({ RegRelSpec_Plain: { x: 0 } });
    const world = createWorld();
    const storage = register(world, archetype([RegRelSpec_Plain]));

    expect(storage.hasRelations).toBe(false);
    expect(storage.relationN).toBe(0);
    expect(world.hasAnyRelations).toBe(false);
    expect(world.relations.length).toBe(0);
  });

  it("destroyWorld resets relation state", () => {
    const Owner = relation("RegRelSpec_Destroy");
    const world = createWorld();
    const storage = register(world, archetype([RelSpec_Comp, Owner]));
    const target = spawn(register(world, archetype([RelSpec_Comp])));
    spawn(storage, { RegRelSpec_Destroy: { target } });

    destroyWorld(world);

    expect(world.reverseMap.size).toBe(0);
    expect(world.relations.length).toBe(0);
    expect(world.hasAnyRelations).toBe(false);
    expect(world.maxTargetIndex).toBe(-1);
  });
});

describe("accessing relation targets", () => {
  it("spawn writes relation target to storage", () => {
    const Owner = relation("SpawnRelSpec_Owner");
    const world = createWorld();
    const storage = register(world, archetype([RelSpec_Comp, Owner]));
    const simpleStorage = register(world, archetype([RelSpec_Comp]));

    const targetId = spawn(simpleStorage);
    const entityId = spawn(storage, { SpawnRelSpec_Owner: { target: targetId } });

    expect(get(storage, entityId, Owner.target)).toBe(targetId);
  });

  it("spawn errors when required relation lacks target", () => {
    const Rel = relation("SpawnTargetGuard_Rel");
    const world = createWorld();
    const storage = register(world, archetype([RelSpec_Comp, Rel]));

    expect(() => {
      // @ts-expect-error a required relation must receive a target at spawn
      spawn(storage);
    }).toThrow("required relation SpawnTargetGuard_Rel must receive a target at spawn");
  });

  it("spawn registers relation in the reverse map", () => {
    const Owner = relation("SpawnReverseMapSpec_Owner");
    const world = createWorld();
    const storage = register(world, archetype([RelSpec_Comp, Owner]));
    const simpleStorage = register(world, archetype([RelSpec_Comp]));

    const targetId = spawn(simpleStorage);
    const sourceId = spawn(storage, { SpawnReverseMapSpec_Owner: { target: targetId } });

    expect(sourceIndices(world, Owner, targetId)).toStrictEqual([entityIndex(sourceId)]);
  });

  it("spawn with required relation maintains reverse map for multiple sources", () => {
    const Link = relation("SpawnRevInsert_Link");
    const world = createWorld();
    const storage = register(world, archetype([RelSpec_Comp, Link]));
    const simpleStorage = register(world, archetype([RelSpec_Comp]));

    const simpleTarget = spawn(simpleStorage);
    const targetId = spawn(storage, { SpawnRevInsert_Link: { target: simpleTarget } });
    const source1 = spawn(storage, { SpawnRevInsert_Link: { target: targetId } });
    const source2 = spawn(storage, { SpawnRevInsert_Link: { target: targetId } });

    const sources = sourceIndices(world, Link, targetId);
    expect(sources.length).toBe(2);
    expect(sources).toContain(entityIndex(source1));
    expect(sources).toContain(entityIndex(source2));
  });

  it("spawn errors when required relation target is stale", () => {
    const Link = relation("SpawnStaleTarget_Link");
    const world = createWorld();
    const storage = register(world, archetype([RelSpec_Comp, Link]));
    const simpleStorage = register(world, archetype([RelSpec_Comp]));

    const simpleTarget = spawn(simpleStorage);
    const targetId = spawn(storage, { SpawnStaleTarget_Link: { target: simpleTarget } });
    despawn(storage, targetId);

    expect(() => {
      spawn(storage, { SpawnStaleTarget_Link: { target: targetId } });
    }).toThrow("stale target ID for relation SpawnStaleTarget_Link");
  });

  it("spawnMany links every batch entity to the shared target", () => {
    const Link = relation("SpawnManyRelSpec_Link");
    const world = createWorld();
    const storage = register(world, archetype([RelSpec_Comp, Link]));
    const simpleStorage = register(world, archetype([RelSpec_Comp]));

    const targetId = spawn(simpleStorage);
    const ids = spawnMany(storage, 3, { SpawnManyRelSpec_Link: { target: targetId } });

    const sources = sourceIndices(world, Link, targetId);
    expect(sources.length).toBe(3);
    for (const id of ids) {
      expect(sources).toContain(entityIndex(id));
      expect(get(storage, id, Link.target)).toBe(targetId);
    }
  });
});

describe("optional relation birth-link at spawn", () => {
  it("spawn with optional relation target creates birth-link", () => {
    const OptionalOwner = relation("OptionalBirthLink_Owner");
    const world = createWorld();
    const storage = register(world, archetype([RelSpec_Comp], [OptionalOwner]));
    const simpleStorage = register(world, archetype([RelSpec_Comp]));

    const targetId = spawn(simpleStorage);
    const entityId = spawn(storage, { OptionalBirthLink_Owner: { target: targetId } });

    expect(sourceIndices(world, OptionalOwner, targetId)).toStrictEqual([entityIndex(entityId)]);
    expect(get(storage, entityId, OptionalOwner.target)).toBe(targetId);
  });

  it("spawn without optional relation key leaves entity unlinked", () => {
    const OptionalUnlinked = relation("OptionalUnlinked");
    const world = createWorld();
    const storage = register(world, archetype([RelSpec_Comp], [OptionalUnlinked]));
    const simpleStorage = register(world, archetype([RelSpec_Comp]));

    const targetId = spawn(simpleStorage);
    const entityId = spawn(storage);

    expect(sourceIndices(world, OptionalUnlinked, targetId)).toStrictEqual([]);
    const row = rowOf(storage, entityId);
    expect(storage.mask[row]).toBe(0);
    const unlinkedMeta = getRelationMeta(OptionalUnlinked);
    assert(unlinkedMeta != null);
    expect(storage.columns.get(unlinkedMeta)?.target?.[row]).toBe(0);
  });

  it("spawn with optional relation and partial data fields", () => {
    const OptionalDataRel = relation("OptionalDataRel", [], { weight: 0, strength: 1 });
    const world = createWorld();
    const storage = register(world, archetype([RelSpec_Comp], [OptionalDataRel]));
    const simpleStorage = register(world, archetype([RelSpec_Comp]));

    const targetId = spawn(simpleStorage);
    const entityId = spawn(storage, { OptionalDataRel: { target: targetId, weight: 5 } });

    expect(sourceIndices(world, OptionalDataRel, targetId)).toStrictEqual([entityIndex(entityId)]);
    expect(get(storage, entityId, OptionalDataRel.target)).toBe(targetId);
    expect(get(storage, entityId, OptionalDataRel.weight)).toBe(5);
    expect(get(storage, entityId, OptionalDataRel.strength)).toBe(1);
  });

  it("spawn with optional relation birth-link errors on stale target", () => {
    const OptionalStaleTarget = relation("OptionalStaleTarget");
    const world = createWorld();
    const storage = register(world, archetype([RelSpec_Comp], [OptionalStaleTarget]));
    const simpleStorage = register(world, archetype([RelSpec_Comp]));

    const simpleTarget = spawn(simpleStorage);
    const targetId = spawn(storage, { OptionalStaleTarget: { target: simpleTarget } });
    despawn(storage, targetId);

    expect(() => {
      spawn(storage, { OptionalStaleTarget: { target: targetId } });
    }).toThrow("stale target ID for relation OptionalStaleTarget");
  });

  it("spawn with optional relation errors on a 0 target", () => {
    const OptionalZeroTarget = relation("OptionalZeroTarget");
    const world = createWorld();
    const storage = register(world, archetype([RelSpec_Comp], [OptionalZeroTarget]));

    expect(() => {
      // @ts-expect-error 0 is not an EntityId
      spawn(storage, { OptionalZeroTarget: { target: 0 } });
    }).toThrow("optional relation OptionalZeroTarget requires a target value");
  });

  it("spawn with optional relation maintains reverse map for multiple sources", () => {
    const OptionalMultiSources = relation("OptionalMultiSources");
    const world = createWorld();
    const storage = register(world, archetype([RelSpec_Comp], [OptionalMultiSources]));
    const simpleStorage = register(world, archetype([RelSpec_Comp]));

    const targetId = spawn(simpleStorage);
    const source1 = spawn(storage, { OptionalMultiSources: { target: targetId } });
    const source2 = spawn(storage, { OptionalMultiSources: { target: targetId } });

    const sources = sourceIndices(world, OptionalMultiSources, targetId);
    expect(sources.length).toBe(2);
    expect(sources).toContain(entityIndex(source1));
    expect(sources).toContain(entityIndex(source2));
  });

  it("recycled slot resets an optional relation's target to sentinel 0", () => {
    const OptionalRecycle = relation("OptionalRecycleSentinel");
    const world = createWorld();
    const storage = register(world, archetype([RelSpec_Comp], [OptionalRecycle]));
    const simpleStorage = register(world, archetype([RelSpec_Comp]));

    const targetId = spawn(simpleStorage);
    const first = spawn(storage, { OptionalRecycleSentinel: { target: targetId } });
    despawn(storage, first);
    const second = spawn(storage);

    const row = rowOf(storage, second);
    const recycleMeta = getRelationMeta(OptionalRecycle);
    assert(recycleMeta != null);
    expect(storage.columns.get(recycleMeta)?.target?.[row]).toBe(0);
  });
});

const BirthLinkAtomic_Rel = relation("BirthLinkAtomic_Rel");

/** World plus a source archetype carrying the optional relation and a plain target archetype. */
function createAtomicFixture() {
  const world = createWorld();
  const storage = register(world, archetype([RelSpec_Comp], [BirthLinkAtomic_Rel]));
  const targetStorage = register(world, archetype([RelSpec_Comp]));
  return { storage, targetStorage, world };
}

type AtomicFixture = ReturnType<typeof createAtomicFixture>;

/** Entity ids an unfiltered `each` walk visits in `storage`. */
function visitAll(storage: AtomicFixture["storage"]): number[] {
  const visited: number[] = [];
  each(storage, (e) => {
    visited.push(e.id);
  });
  return visited;
}

/**
 * Entity ids the `all: [BirthLinkAtomic_Rel]` matcher visits in `storage`.
 *
 * Also doubles as matcher warm-up: calling it during Arrange materializes and
 * refreshes the cached matcher, so a later call exercises the cached path — the
 * one that can observe a stale presence bit left on a recycled row.
 */
function visitLinked(storage: AtomicFixture["storage"]): number[] {
  const visited: number[] = [];
  each(storage, { all: [BirthLinkAtomic_Rel] }, (e) => {
    visited.push(e.id);
  });
  return visited;
}

interface InvalidTargetCase {
  readonly label: string;
  readonly error: string;
  readonly makeTarget: (fixture: AtomicFixture) => EntityId;
}

interface RowStateCase {
  readonly label: string;
  /** Brings `storage` to the desired allocation state, leaving it with zero live rows. */
  readonly prepare: (fixture: AtomicFixture) => void;
}

const invalidTargets: InvalidTargetCase[] = [
  {
    error: "stale target ID for relation BirthLinkAtomic_Rel",
    label: "a stale target",
    makeTarget: ({ targetStorage }) => {
      const id = spawn(targetStorage);
      despawn(targetStorage, id);
      return id;
    },
  },
  {
    error: "optional relation BirthLinkAtomic_Rel requires a target value",
    label: "a zero target",
    makeTarget: (): EntityId => {
      // @ts-expect-error 0 is the unlinked sentinel, never a valid entity id
      return 0;
    },
  },
];

const rowStates: RowStateCase[] = [
  {
    label: "fresh",
    prepare: () => {
      // A brand-new storage already allocates the next spawn on a fresh row.
    },
  },
  {
    label: "recycled",
    prepare: ({ storage, targetStorage }) => {
      const target = spawn(targetStorage);
      const first = spawn(storage, { BirthLinkAtomic_Rel: { target } });
      visitLinked(storage);
      despawn(storage, first);
    },
  },
];

const atomicCases = invalidTargets.flatMap((invalid) =>
  rowStates.map((row) => ({
    error: invalid.error,
    makeTarget: invalid.makeTarget,
    name: `${invalid.label} on a ${row.label} row`,
    prepare: row.prepare,
  })),
);

describe("checked-mode birth-link validation", () => {
  it.each(atomicCases)("rejects $name without mutating the world", (testCase) => {
    const fixture = createAtomicFixture();
    testCase.prepare(fixture);
    const { storage, world } = fixture;
    const target = testCase.makeTarget(fixture);
    const beforeN = storage.n;
    const beforeNextIndex = world.nextIndex;
    const beforeFreeHead = world.freeHead;

    expect(() => {
      spawn(storage, { BirthLinkAtomic_Rel: { target } });
    }).toThrow(testCase.error);

    expect(storage.n).toBe(beforeN);
    expect(world.nextIndex).toBe(beforeNextIndex);
    expect(world.freeHead).toBe(beforeFreeHead);
    expect(visitAll(storage)).toStrictEqual([]);
    expect(visitLinked(storage)).toStrictEqual([]);
  });

  it("reuses the recycled slot cleanly after a rejected birth-link spawn", () => {
    const { storage, targetStorage, world } = createAtomicFixture();
    const target = spawn(targetStorage);
    const first = spawn(storage, { BirthLinkAtomic_Rel: { target } });
    visitLinked(storage);
    despawn(storage, first);
    const stale = spawn(targetStorage);
    despawn(targetStorage, stale);
    expect(() => {
      spawn(storage, { BirthLinkAtomic_Rel: { target: stale } });
    }).toThrow("stale target ID for relation BirthLinkAtomic_Rel");

    const reused = spawn(storage, { BirthLinkAtomic_Rel: { target } });

    expect(entityIndex(reused)).toBe(entityIndex(first));
    expect(alive(storage, first)).toBe(false);
    expect(alive(storage, reused)).toBe(true);
    expect(storage.n).toBe(1);
    expect(get(storage, reused, BirthLinkAtomic_Rel.target)).toBe(target);
    expect(sourceIndices(world, BirthLinkAtomic_Rel, target)).toStrictEqual([entityIndex(reused)]);
    expect(visitLinked(storage)).toStrictEqual([reused]);
  });
});

describe("reverse map maintenance", () => {
  it("reverseInsert raises the watermark on a bucket's first entry only", () => {
    const Rel = relation("ReverseMapSpec_Watermark");
    const world = createWorld();
    const storage = register(world, archetype([RelSpec_Comp], [Rel]));
    const simpleStorage = register(world, archetype([RelSpec_Comp]));

    expect(world.maxTargetIndex).toBe(-1);

    const targetA = spawn(simpleStorage);
    const targetB = spawn(simpleStorage);
    spawn(storage, { ReverseMapSpec_Watermark: { target: targetB } });
    const highWater = world.maxTargetIndex;
    expect(highWater).toBe(entityIndex(targetB));

    // A lower target index never lowers the watermark
    spawn(storage, { ReverseMapSpec_Watermark: { target: targetA } });
    expect(world.maxTargetIndex).toBe(highWater);
  });

  it("maintains the single-storage flag: sole storage, degraded once, never re-promoted", () => {
    const Rel = relation("ReverseMapSpec_Flag");
    const { ReverseMapSpec_Other } = components({ ReverseMapSpec_Other: { x: 0 } });
    const world = createWorld();
    const storageA = register(world, archetype([RelSpec_Comp], [Rel]));
    const storageB = register(world, archetype([ReverseMapSpec_Other], [Rel]));
    const simpleStorage = register(world, archetype([RelSpec_Comp]));

    const meta = getRelationMeta(Rel);
    assert(meta != null);
    const targetId = spawn(simpleStorage);
    const targetIndex = entityIndex(targetId);

    const sourceA = spawn(storageA, { ReverseMapSpec_Flag: { target: targetId } });
    const relMap = world.reverseMap.get(meta);
    assert(relMap != null);
    expect(relMap.get(-1)).toBe(storageA);

    spawn(storageB, { ReverseMapSpec_Flag: { target: targetId } });
    expect(relMap.get(-1)).toBe(false);

    // Removing every source and re-inserting from one storage never re-promotes
    reverseRemove(world.reverseMap, meta, targetIndex, entityIndex(sourceA));
    reverseInsert({ state: world, rel: meta }, targetIndex, storageA, entityIndex(sourceA));
    expect(relMap.get(-1)).toBe(false);
  });

  it("reverseRemove deletes the entry but keeps the empty bucket", () => {
    const Rel = relation("ReverseMapSpec_Remove");
    const world = createWorld();
    const storage = register(world, archetype([RelSpec_Comp], [Rel]));
    const simpleStorage = register(world, archetype([RelSpec_Comp]));

    const meta = getRelationMeta(Rel);
    assert(meta != null);
    const targetId = spawn(simpleStorage);
    const sourceId = spawn(storage, { ReverseMapSpec_Remove: { target: targetId } });
    const targetIndex = entityIndex(targetId);

    reverseRemove(world.reverseMap, meta, targetIndex, entityIndex(sourceId));

    const reverseMap = world.reverseMap.get(meta);
    assert(reverseMap != null);
    const bucket = sourceBucket(reverseMap, targetIndex);
    expect(bucket).toBeDefined();
    expect(bucket?.size).toBe(0);
  });
});

describe("getTarget", () => {
  it("returns the target entity ID", () => {
    const Link = relation("GetTargetSpec_Link");
    const world = createWorld();
    const storage = register(world, archetype([RelSpec_Comp, Link]));
    const simpleStorage = register(world, archetype([RelSpec_Comp]));

    const targetId = spawn(simpleStorage);
    const entityId = spawn(storage, { GetTargetSpec_Link: { target: targetId } });

    expect(getTarget(world, entityId, Link)).toBe(targetId);
  });

  it("returns undefined for dead targets", () => {
    const Link = relation("GetTargetSpec_Dead");
    const world = createWorld();
    const storage = register(world, archetype([RelSpec_Comp], [Link]));
    const simpleStorage = register(world, archetype([RelSpec_Comp]));

    const targetId = spawn(simpleStorage);
    const entityId = spawn(storage, { GetTargetSpec_Dead: { target: targetId } });
    despawn(simpleStorage, targetId);

    expect(getTarget(world, entityId, Link)).toBeUndefined();
  });

  it("returns undefined for a stale source", () => {
    const Link = relation("GetTargetSpec_StaleSource");
    const world = createWorld();
    const storage = register(world, archetype([RelSpec_Comp], [Link]));
    const simpleStorage = register(world, archetype([RelSpec_Comp]));

    const targetId = spawn(simpleStorage);
    const entityId = spawn(storage, { GetTargetSpec_StaleSource: { target: targetId } });
    despawn(storage, entityId);

    expect(getTarget(world, entityId, Link)).toBeUndefined();
  });

  it("returns undefined for an unlinked optional relation", () => {
    const Link = relation("GetTargetSpec_Unlinked");
    const world = createWorld();
    const storage = register(world, archetype([RelSpec_Comp], [Link]));

    const entityId = spawn(storage);

    expect(getTarget(world, entityId, Link)).toBeUndefined();
  });

  it("errors when the relation is not on the entity's archetype", () => {
    const OnArch = relation("GetTargetSpec_OnArch");
    const NotOnArch = relation("GetTargetSpec_NotOnArch");
    const world = createWorld();
    register(world, archetype([RelSpec_Comp], [OnArch]));
    const simpleStorage = register(world, archetype([RelSpec_Comp]));

    const entityId = spawn(simpleStorage);

    expect(() => {
      getTarget(world, entityId, NotOnArch);
    }).toThrow("relation not on this entity's archetype");
  });
});

describe("link and unlink", () => {
  it("link creates the reverse entry and getTarget resolves it", () => {
    const Rel = relation("LinkSpec_Optional");
    const world = createWorld();
    const storage = register(world, archetype([RelSpec_Comp], [Rel]));

    const targetId = spawn(storage);
    const sourceId = spawn(storage);
    link(world, sourceId, Rel, targetId);

    expect(getTarget(world, sourceId, Rel)).toBe(targetId);
    expect(sourceIndices(world, Rel, targetId)).toStrictEqual([entityIndex(sourceId)]);
  });

  it("link retargets: removes the previous target's entry and adds the new one", () => {
    const Rel = relation("LinkSpec_Retarget");
    const world = createWorld();
    const storage = register(world, archetype([RelSpec_Comp], [Rel]));

    const targetA = spawn(storage);
    const targetB = spawn(storage);
    const sourceId = spawn(storage);
    link(world, sourceId, Rel, targetA);

    link(world, sourceId, Rel, targetB);

    expect(getTarget(world, sourceId, Rel)).toBe(targetB);
    expect(sourceIndices(world, Rel, targetA)).toStrictEqual([]);
    expect(sourceIndices(world, Rel, targetB)).toStrictEqual([entityIndex(sourceId)]);
  });

  it("link writes data fields on a required relation", () => {
    const DataRel = relation("LinkSpec_RequiredData", [], { weight: 0 });
    const world = createWorld();
    const storage = register(world, archetype([RelSpec_Comp, DataRel]));
    const simpleStorage = register(world, archetype([RelSpec_Comp]));

    const targetA = spawn(simpleStorage);
    const targetB = spawn(simpleStorage);
    const sourceId = spawn(storage, { LinkSpec_RequiredData: { target: targetA } });

    link(world, sourceId, DataRel, targetB, { weight: 7 });

    expect(getTarget(world, sourceId, DataRel)).toBe(targetB);
    expect(get(storage, sourceId, DataRel.weight)).toBe(7);
    expect(sourceIndices(world, DataRel, targetA)).toStrictEqual([]);
    expect(sourceIndices(world, DataRel, targetB)).toStrictEqual([entityIndex(sourceId)]);
  });

  it("link errors on a stale source ID", () => {
    const Rel = relation("LinkSpec_StaleSource");
    const world = createWorld();
    const storage = register(world, archetype([RelSpec_Comp], [Rel]));

    const targetId = spawn(storage);
    const sourceId = spawn(storage);
    despawn(storage, sourceId);

    expect(() => {
      link(world, sourceId, Rel, targetId);
    }).toThrow("stale entity ID");
  });

  it("link errors on a stale target", () => {
    const Rel = relation("LinkSpec_StaleTarget");
    const world = createWorld();
    const storage = register(world, archetype([RelSpec_Comp], [Rel]));

    const targetId = spawn(storage);
    const sourceId = spawn(storage);
    despawn(storage, targetId);

    expect(() => {
      link(world, sourceId, Rel, targetId);
    }).toThrow("stale target ID for relation LinkSpec_StaleTarget");
  });

  it("unlink clears the target column, presence bit, and reverse entry", () => {
    const Rel = relation("UnlinkSpec_Clear");
    const world = createWorld();
    const storage = register(world, archetype([RelSpec_Comp], [Rel]));

    const targetId = spawn(storage);
    const sourceId = spawn(storage);
    link(world, sourceId, Rel, targetId);

    unlink(world, sourceId, Rel);

    expect(getTarget(world, sourceId, Rel)).toBeUndefined();
    expect(sourceIndices(world, Rel, targetId)).toStrictEqual([]);
    const row = rowOf(storage, sourceId);
    expect(storage.mask[row]).toBe(0);
    const relMeta = getRelationMeta(Rel);
    assert(relMeta != null);
    expect(storage.columns.get(relMeta)?.target?.[row]).toBe(0);
  });

  it("unlink on an already-unlinked optional relation is a no-op", () => {
    const Rel = relation("UnlinkSpec_NoOp");
    const world = createWorld();
    const storage = register(world, archetype([RelSpec_Comp], [Rel]));

    const sourceId = spawn(storage);

    unlink(world, sourceId, Rel);

    expect(getTarget(world, sourceId, Rel)).toBeUndefined();
  });

  it("unlink errors on a required relation", () => {
    const Rel = relation("UnlinkSpec_Required");
    const world = createWorld();
    const storage = register(world, archetype([RelSpec_Comp, Rel]));
    const simpleStorage = register(world, archetype([RelSpec_Comp]));

    const targetId = spawn(simpleStorage);
    const sourceId = spawn(storage, { UnlinkSpec_Required: { target: targetId } });

    expect(() => {
      unlink(world, sourceId, Rel);
    }).toThrow("cannot unlink required relation UnlinkSpec_Required");
  });

  it("unlink errors on a stale source ID", () => {
    const Rel = relation("UnlinkSpec_StaleSource");
    const world = createWorld();
    const storage = register(world, archetype([RelSpec_Comp], [Rel]));

    const sourceId = spawn(storage);
    despawn(storage, sourceId);

    expect(() => {
      unlink(world, sourceId, Rel);
    }).toThrow("stale entity ID");
  });
});

describe("link/unlink archetype guard", () => {
  it("link errors when relation not on archetype", () => {
    const OnArch = relation("ArchGuard_OnArch");
    const NotOnArch = relation("ArchGuard_NotOnArch");
    const world = createWorld();
    const simpleStorage = register(world, archetype([RelSpec_Comp]));
    const storage = register(world, archetype([RelSpec_Comp, OnArch]));

    const targetId = spawn(simpleStorage);
    const entityId = spawn(storage, { ArchGuard_OnArch: { target: targetId } });

    expect(() => {
      link(world, entityId, NotOnArch, targetId);
    }).toThrow("relation not on this entity's archetype");
  });

  it("unlink errors when relation not on archetype", () => {
    const OnArch = relation("ArchGuard_OnArch2");
    const NotOnArch = relation("ArchGuard_NotOnArch2");
    const world = createWorld();
    const simpleStorage = register(world, archetype([RelSpec_Comp]));
    const storage = register(world, archetype([RelSpec_Comp, OnArch]));

    const targetId = spawn(simpleStorage);
    const entityId = spawn(storage, { ArchGuard_OnArch2: { target: targetId } });

    expect(() => {
      unlink(world, entityId, NotOnArch);
    }).toThrow("relation not on this entity's archetype");
  });
});

describe("filtered each reflects link/unlink mutations", () => {
  it("filtered each reflects a newly linked optional relation", () => {
    const Rel = relation("LinkMatcherCache_Rel");
    const world = createWorld();
    const storage = register(world, archetype([RelSpec_Comp], [Rel]));

    const targetId = spawn(storage);
    const sourceId = spawn(storage);

    let matchedCountBefore = 0;
    each(storage, { all: [Rel] }, () => {
      matchedCountBefore += 1;
    });
    expect(matchedCountBefore).toBe(0);

    link(world, sourceId, Rel, targetId);

    let matchedCountAfter = 0;
    each(storage, { all: [Rel] }, (e) => {
      matchedCountAfter += 1;
      expect(e.id).toBe(sourceId);
    });
    expect(matchedCountAfter).toBe(1);
  });

  it("filtered each excludes unlinked optional relation", () => {
    const Rel = relation("UnlinkMatcherCache_Rel");
    const world = createWorld();
    const storage = register(world, archetype([RelSpec_Comp], [Rel]));

    // Establish the relation with link() before any matcher exists — with no
    // matchers yet, link()'s own refresh is a no-op, so this isolates unlink().
    const targetId = spawn(storage);
    const sourceId = spawn(storage);
    link(world, sourceId, Rel, targetId);

    let matchedCountBefore = 0;
    each(storage, { all: [Rel] }, (e) => {
      matchedCountBefore += 1;
      expect(e.id).toBe(sourceId);
    });
    expect(matchedCountBefore).toBe(1);

    unlink(world, sourceId, Rel);

    let matchedCountAfter = 0;
    each(storage, { all: [Rel] }, () => {
      matchedCountAfter += 1;
    });
    expect(matchedCountAfter).toBe(0);
  });
});

describe("link value cloning", () => {
  it("link stores object values by reference — mutating the caller object affects stored state", () => {
    const LinkRefTest = relation("LinkRefTest", [], {
      config: ref<{ enabled: boolean; timeout: number }>(),
    });
    const world = createWorld();
    const storage = register(world, archetype([RelSpec_Comp, LinkRefTest]));
    const simpleStorage = register(world, archetype([RelSpec_Comp]));

    const targetId = spawn(simpleStorage);
    const sourceId = spawn(storage, { LinkRefTest: { target: targetId } });

    const configObj = { enabled: true, timeout: 1000 };
    link(world, sourceId, LinkRefTest, targetId, { config: configObj });
    configObj.enabled = false;
    configObj.timeout = 9999;

    // Reference semantics: the stored value IS the caller's object
    const storedConfig = get(storage, sourceId, LinkRefTest.config);
    expect(storedConfig).toBe(configObj);
    expect(storedConfig?.enabled).toBe(false);
    expect(storedConfig?.timeout).toBe(9999);
  });
});

describe("getRelationMeta", () => {
  it("returns the relation descriptor for a relation", () => {
    const Owner = relation("RelSpec_MetaOwner", [RelSpec_Comp]);
    const meta = getRelationMeta(Owner);
    expect(meta).toBe(Owner);
    expect(meta?.isRelation).toBe(true);
    expect(meta?.constraints[0]).toBe(RelSpec_Comp);
  });

  it("returns undefined for a plain component", () => {
    expect(getRelationMeta(RelSpec_Comp)).toBeUndefined();
  });

  it.each([
    { label: "null", value: null },
    { label: "number", value: 42 },
    { label: "string", value: "Owner" },
    { label: "plain object", value: { isRelation: false } },
  ])("returns undefined for non-descriptor value ($label)", ({ value }) => {
    expect(getRelationMeta(value)).toBeUndefined();
  });
});
