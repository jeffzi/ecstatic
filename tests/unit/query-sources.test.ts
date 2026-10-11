import { describe, expect, it } from "vitest";

import {
  archetype,
  components,
  countSources,
  createWorld,
  despawn,
  getSources,
  hasSources,
  link,
  querySources,
  register,
  relation,
  spawn,
  unlink,
} from "../../src/index.js";

const { QSSpec_Comp } = components({ QSSpec_Comp: { x: 0 } });

describe("querySources", () => {
  it("visits every source linked to the target", () => {
    const Rel = relation("QuerySourcesAll_Rel");
    const world = createWorld();
    const simple = register(world, archetype([QSSpec_Comp]));
    const storage = register(world, archetype([QSSpec_Comp, Rel]));

    const target = spawn(simple);
    const source1 = spawn(storage, { QuerySourcesAll_Rel: { target } });
    const source2 = spawn(storage, { QuerySourcesAll_Rel: { target } });

    const found = new Set<number>();
    querySources(world, Rel, target, (e) => {
      found.add(e.id);
    });

    expect(found.size).toBe(2);
    expect(found.has(source1)).toBe(true);
    expect(found.has(source2)).toBe(true);
  });

  it("binds the pooled view: relation fields and source components are readable", () => {
    const DataRel = relation("QuerySourcesView_Rel", [], { weight: 0 });
    const world = createWorld();
    const simple = register(world, archetype([QSSpec_Comp]));
    const storage = register(world, archetype([QSSpec_Comp, DataRel]));

    const target = spawn(simple);
    spawn(storage, {
      QSSpec_Comp: { x: 11 },
      QuerySourcesView_Rel: { target, weight: 7 },
    });

    expect.hasAssertions();
    querySources(world, DataRel, target, [QSSpec_Comp], (e) => {
      expect(e.QSSpec_Comp.x).toBe(11);
      expect(e.QuerySourcesView_Rel.weight).toBe(7);
    });
  });

  it("with a component filter visits only matching sources", () => {
    const Rel = relation("QuerySourcesFilter_Rel");
    const { QuerySourcesFilter_Extra } = components({ QuerySourcesFilter_Extra: { v: 0 } });
    const world = createWorld();
    const simple = register(world, archetype([QSSpec_Comp]));
    const plain = register(world, archetype([QSSpec_Comp, Rel]));
    const extra = register(world, archetype([QSSpec_Comp, Rel, QuerySourcesFilter_Extra]));

    // Two sources in different archetypes; only the one with Extra survives the filter
    const target = spawn(simple);
    spawn(plain, { QuerySourcesFilter_Rel: { target } });
    const extraSource = spawn(extra, { QuerySourcesFilter_Rel: { target } });

    const found = new Set<number>();
    querySources(world, Rel, target, [QuerySourcesFilter_Extra], (e) => {
      found.add(e.id);
    });

    expect(found.size).toBe(1);
    expect(found.has(extraSource)).toBe(true);
  });

  it("filters per source on enabled optional bits (single-storage fast path)", () => {
    const Rel = relation("QuerySourcesOptBit_Rel");
    const { QuerySourcesOptBit_Flag } = components({ QuerySourcesOptBit_Flag: {} });
    const world = createWorld();
    const simple = register(world, archetype([QSSpec_Comp]));
    const storage = register(world, archetype([QSSpec_Comp, Rel], [QuerySourcesOptBit_Flag]));

    const target = spawn(simple);
    spawn(storage, { QuerySourcesOptBit_Rel: { target } });
    const flagged = spawn(storage, {
      QuerySourcesOptBit_Rel: { target },
      QuerySourcesOptBit_Flag: true,
    });

    const found = new Set<number>();
    querySources(world, Rel, target, { all: [QuerySourcesOptBit_Flag] }, (e) => {
      found.add(e.id);
    });

    expect(found.size).toBe(1);
    expect(found.has(flagged)).toBe(true);
  });

  it("visits sources across multiple archetypes without a filter", () => {
    const Rel = relation("QuerySourcesMulti_Rel");
    const { QuerySourcesMulti_Other } = components({ QuerySourcesMulti_Other: { v: 0 } });
    const world = createWorld();
    const simple = register(world, archetype([QSSpec_Comp]));
    const storageA = register(world, archetype([QSSpec_Comp, Rel]));
    const storageB = register(world, archetype([QuerySourcesMulti_Other, Rel]));

    const target = spawn(simple);
    const sourceA = spawn(storageA, { QuerySourcesMulti_Rel: { target } });
    const sourceB = spawn(storageB, { QuerySourcesMulti_Rel: { target } });

    const found = new Set<number>();
    querySources(world, Rel, target, (e) => {
      found.add(e.id);
    });

    expect(found.size).toBe(2);
    expect(found.has(sourceA)).toBe(true);
    expect(found.has(sourceB)).toBe(true);
  });

  it("filters with { none } and no all axis", () => {
    const Rel = relation("QuerySourcesNoneOnly_Rel");
    const { QuerySourcesNoneOnly_Tag } = components({ QuerySourcesNoneOnly_Tag: {} });
    const world = createWorld();
    const simple = register(world, archetype([QSSpec_Comp]));
    const plain = register(world, archetype([QSSpec_Comp, Rel]));
    const tagged = register(world, archetype([QSSpec_Comp, Rel], [QuerySourcesNoneOnly_Tag]));

    const target = spawn(simple);
    const plainSrc = spawn(plain, { QuerySourcesNoneOnly_Rel: { target } });
    const taggedSrc = spawn(tagged, {
      QuerySourcesNoneOnly_Rel: { target },
      QuerySourcesNoneOnly_Tag: true,
    });

    const found: number[] = [];
    querySources(world, Rel, target, { none: [QuerySourcesNoneOnly_Tag] }, (e) => {
      found.push(e.id);
    });

    expect(found).toStrictEqual([plainSrc]);
    expect(found).not.toContain(taggedSrc);
  });

  it("skips everything when the filter can never match the sole source storage", () => {
    const Rel = relation("QuerySourcesNoMatch_Rel");
    const { QuerySourcesNoMatch_Absent } = components({ QuerySourcesNoMatch_Absent: { v: 0 } });
    const world = createWorld();
    const simple = register(world, archetype([QSSpec_Comp]));
    const storage = register(world, archetype([QSSpec_Comp, Rel]));
    register(world, archetype([QuerySourcesNoMatch_Absent]));

    const target = spawn(simple);
    spawn(storage, { QuerySourcesNoMatch_Rel: { target } });

    let count = 0;
    querySources(world, Rel, target, [QuerySourcesNoMatch_Absent], () => {
      count += 1;
    });

    expect(count).toBe(0);
  });

  it("re-resolves the matcher when the bucket crosses matching storages", () => {
    const Rel = relation("QuerySourcesCross_Rel");
    const { QuerySourcesCross_Other } = components({ QuerySourcesCross_Other: { v: 0 } });
    const world = createWorld();
    const simple = register(world, archetype([QSSpec_Comp]));
    const storageA = register(world, archetype([QSSpec_Comp, Rel]));
    const storageB = register(world, archetype([QuerySourcesCross_Other, QSSpec_Comp, Rel]));

    const target = spawn(simple);
    const sourceA = spawn(storageA, { QuerySourcesCross_Rel: { target } });
    const sourceB = spawn(storageB, { QuerySourcesCross_Rel: { target } });

    const found = new Set<number>();
    querySources(world, Rel, target, [QSSpec_Comp], (e) => {
      found.add(e.id);
    });

    expect(found.size).toBe(2);
    expect(found.has(sourceA)).toBe(true);
    expect(found.has(sourceB)).toBe(true);
  });

  it("throws on a non-function callback in both forms", () => {
    const Rel = relation("QuerySourcesBadFn_Rel");
    const world = createWorld();
    const simple = register(world, archetype([QSSpec_Comp]));
    const storage = register(world, archetype([QSSpec_Comp, Rel]));
    const target = spawn(simple);
    spawn(storage, { QuerySourcesBadFn_Rel: { target } });

    expect(() => {
      // @ts-expect-error the callback must be a function
      querySources(world, Rel, target, 42);
    }).toThrow("invalid querySources callback");
    expect(() => {
      // @ts-expect-error the callback must be a function
      querySources(world, Rel, target, [QSSpec_Comp], 42);
    }).toThrow("invalid querySources callback");
  });

  it("visits nothing when every source has unlinked (empty bucket)", () => {
    const Rel = relation("QuerySourcesEmpty_Rel");
    const world = createWorld();
    const simple = register(world, archetype([QSSpec_Comp]));
    const storage = register(world, archetype([QSSpec_Comp], [Rel]));

    const target = spawn(simple);
    const source = spawn(storage);
    link(world, source, Rel, target);
    unlink(world, source, Rel);

    let count = 0;
    querySources(world, Rel, target, () => {
      count += 1;
    });
    expect(count).toBe(0);
  });

  it("tests enabled bits per row across consecutive same-storage entries (multi-storage path)", () => {
    const Rel = relation("QuerySourcesRuns_Rel");
    const { QuerySourcesRuns_Flag, QuerySourcesRuns_Other } = components({
      QuerySourcesRuns_Flag: {},
      QuerySourcesRuns_Other: { v: 0 },
    });
    const world = createWorld();
    const simple = register(world, archetype([QSSpec_Comp]));
    const storageA = register(world, archetype([QSSpec_Comp, Rel], [QuerySourcesRuns_Flag]));
    const storageB = register(
      world,
      archetype([QuerySourcesRuns_Other, Rel], [QuerySourcesRuns_Flag]),
    );

    const target = spawn(simple);
    const flaggedA = spawn(storageA, {
      QuerySourcesRuns_Rel: { target },
      QuerySourcesRuns_Flag: true,
    });
    spawn(storageA, { QuerySourcesRuns_Rel: { target } });
    const flaggedB = spawn(storageB, {
      QuerySourcesRuns_Rel: { target },
      QuerySourcesRuns_Flag: true,
    });
    spawn(storageB, { QuerySourcesRuns_Rel: { target } });

    const found = new Set<number>();
    querySources(world, Rel, target, { all: [QuerySourcesRuns_Flag] }, (e) => {
      found.add(e.id);
    });

    expect(found.size).toBe(2);
    expect(found.has(flaggedA)).toBe(true);
    expect(found.has(flaggedB)).toBe(true);
  });

  it("visits nothing when the filter matches no source storage (multi-storage path)", () => {
    const Rel = relation("QuerySourcesAllSkip_Rel");
    const { QuerySourcesAllSkip_Absent, QuerySourcesAllSkip_Other } = components({
      QuerySourcesAllSkip_Absent: { v: 0 },
      QuerySourcesAllSkip_Other: { v: 0 },
    });
    const world = createWorld();
    const simple = register(world, archetype([QSSpec_Comp]));
    const storageA = register(world, archetype([QSSpec_Comp, Rel]));
    const storageB = register(world, archetype([QuerySourcesAllSkip_Other, Rel]));
    register(world, archetype([QuerySourcesAllSkip_Absent]));

    const target = spawn(simple);
    spawn(storageA, { QuerySourcesAllSkip_Rel: { target } });
    spawn(storageB, { QuerySourcesAllSkip_Rel: { target } });

    let count = 0;
    querySources(world, Rel, target, [QuerySourcesAllSkip_Absent], () => {
      count += 1;
    });
    expect(count).toBe(0);
  });

  it("visits nothing for a stale target and for a target with no sources", () => {
    const Rel = relation("QuerySourcesStale_Rel");
    const world = createWorld();
    const simple = register(world, archetype([QSSpec_Comp]));
    const storage = register(world, archetype([QSSpec_Comp, Rel]));

    const bare = spawn(simple);
    const target = spawn(simple);
    spawn(storage, { QuerySourcesStale_Rel: { target } });
    despawn(simple, target);

    let count = 0;
    querySources(world, Rel, target, () => {
      count += 1;
    });
    querySources(world, Rel, bare, () => {
      count += 1;
    });
    expect(count).toBe(0);
  });

  it("despawning the current source mid-callback is safe", () => {
    const Rel = relation("QuerySourcesDespawn_Rel");
    const world = createWorld();
    const simple = register(world, archetype([QSSpec_Comp]));
    const storage = register(world, archetype([QSSpec_Comp, Rel]));

    const target = spawn(simple);
    spawn(storage, { QuerySourcesDespawn_Rel: { target } });
    spawn(storage, { QuerySourcesDespawn_Rel: { target } });

    let visited = 0;
    querySources(world, Rel, target, (e) => {
      visited += 1;
      despawn(storage, e.id);
    });

    expect(visited).toBe(2);
  });

  describe("when a callback adds a source mid-pass", () => {
    it("binds a cross-archetype source to its own row on a filtered walk", () => {
      const Rel = relation("QSLinkCross_Rel");
      const { QSLinkCross_Data, QSLinkCross_Other } = components({
        QSLinkCross_Data: { v: 0 },
        QSLinkCross_Other: { w: 0 },
      });
      const world = createWorld();
      const simple = register(world, archetype([QSSpec_Comp]));
      const storageA = register(world, archetype([QSSpec_Comp, Rel], [QSLinkCross_Data]));
      const storageB = register(world, archetype([QSLinkCross_Other, Rel], [QSLinkCross_Data]));

      const target = spawn(simple);
      const decoy = spawn(simple);
      const sourceA = spawn(storageA, {
        QSLinkCross_Data: { v: 1 },
        QSLinkCross_Rel: { target },
      });
      const sourceB = spawn(storageB, {
        QSLinkCross_Data: { v: 2 },
        QSLinkCross_Rel: { target: decoy },
      });

      const seen: [number, number][] = [];
      let linked = false;
      querySources(world, Rel, target, { all: [QSLinkCross_Data] }, (e) => {
        seen.push([e.id, e.QSLinkCross_Data.v]);
        if (!linked) {
          linked = true;
          link(world, sourceB, Rel, target);
        }
      });

      expect(seen).toStrictEqual([
        [sourceA, 1],
        [sourceB, 2],
      ]);
    });

    it("binds a source from an archetype registered mid-pass to its own row", () => {
      const Rel = relation("QSLinkLate_Rel");
      const { QSLinkLate_Data, QSLinkLate_Other } = components({
        QSLinkLate_Data: { v: 0 },
        QSLinkLate_Other: { w: 0 },
      });
      const world = createWorld();
      const simple = register(world, archetype([QSSpec_Comp]));
      const storageA = register(world, archetype([QSSpec_Comp, Rel], [QSLinkLate_Data]));

      const target = spawn(simple);
      const sourceA = spawn(storageA, { QSLinkLate_Data: { v: 1 }, QSLinkLate_Rel: { target } });

      const seen: [number, number][] = [];
      let sourceB: number | undefined;
      querySources(world, Rel, target, { all: [QSLinkLate_Data] }, (e) => {
        seen.push([e.id, e.QSLinkLate_Data.v]);
        if (sourceB === undefined) {
          const storageB = register(world, archetype([QSLinkLate_Other, Rel], [QSLinkLate_Data]));
          sourceB = spawn(storageB, { QSLinkLate_Data: { v: 2 }, QSLinkLate_Rel: { target } });
        }
      });

      expect(seen).toStrictEqual([
        [sourceA, 1],
        [sourceB, 2],
      ]);
    });

    it("skips a source from an archetype registered mid-pass that fails the filter", () => {
      const Rel = relation("QSLinkLateSkip_Rel");
      const { QSLinkLateSkip_Data, QSLinkLateSkip_Other } = components({
        QSLinkLateSkip_Data: { v: 0 },
        QSLinkLateSkip_Other: { w: 0 },
      });
      const world = createWorld();
      const simple = register(world, archetype([QSSpec_Comp]));
      const storageA = register(world, archetype([QSSpec_Comp, Rel], [QSLinkLateSkip_Data]));

      const target = spawn(simple);
      const sourceA = spawn(storageA, {
        QSLinkLateSkip_Data: { v: 1 },
        QSLinkLateSkip_Rel: { target },
      });

      const seen: [number, number][] = [];
      let spawned = false;
      querySources(world, Rel, target, { all: [QSLinkLateSkip_Data] }, (e) => {
        seen.push([e.id, e.QSLinkLateSkip_Data.v]);
        if (!spawned) {
          spawned = true;
          // storageB lacks the filtered component entirely, so its source must be skipped
          const storageB = register(world, archetype([QSLinkLateSkip_Other, Rel]));
          spawn(storageB, { QSLinkLateSkip_Rel: { target } });
        }
      });

      expect(seen).toStrictEqual([[sourceA, 1]]);
    });

    it("binds a same-archetype source to its own row on a filtered walk", () => {
      const Rel = relation("QSLinkSame_Rel");
      const { QSLinkSame_Data } = components({ QSLinkSame_Data: { v: 0 } });
      const world = createWorld();
      const simple = register(world, archetype([QSSpec_Comp]));
      const storage = register(world, archetype([QSSpec_Comp, Rel], [QSLinkSame_Data]));

      const target = spawn(simple);
      const decoy = spawn(simple);
      const sourceA = spawn(storage, { QSLinkSame_Data: { v: 1 }, QSLinkSame_Rel: { target } });
      const sourceB = spawn(storage, {
        QSLinkSame_Data: { v: 2 },
        QSLinkSame_Rel: { target: decoy },
      });

      const seen: [number, number][] = [];
      let linked = false;
      querySources(world, Rel, target, { all: [QSLinkSame_Data] }, (e) => {
        seen.push([e.id, e.QSLinkSame_Data.v]);
        if (!linked) {
          linked = true;
          link(world, sourceB, Rel, target);
        }
      });

      expect(seen).toStrictEqual([
        [sourceA, 1],
        [sourceB, 2],
      ]);
    });

    it("binds a cross-archetype source to its own row on an unfiltered walk", () => {
      const Rel = relation("QSLinkUnfiltered_Rel", [], { weight: 0 });
      const { QSLinkUnfiltered_Other } = components({ QSLinkUnfiltered_Other: { w: 0 } });
      const world = createWorld();
      const simple = register(world, archetype([QSSpec_Comp]));
      const storageA = register(world, archetype([QSSpec_Comp, Rel]));
      const storageB = register(world, archetype([QSLinkUnfiltered_Other, Rel]));

      const target = spawn(simple);
      const decoy = spawn(simple);
      const sourceA = spawn(storageA, { QSLinkUnfiltered_Rel: { target, weight: 1 } });
      const sourceB = spawn(storageB, { QSLinkUnfiltered_Rel: { target: decoy, weight: 2 } });

      const seen: [number, number][] = [];
      let linked = false;
      querySources(world, Rel, target, (e) => {
        seen.push([e.id, e.QSLinkUnfiltered_Rel.weight]);
        if (!linked) {
          linked = true;
          link(world, sourceB, Rel, target, { weight: 2 });
        }
      });

      expect(seen).toStrictEqual([
        [sourceA, 1],
        [sourceB, 2],
      ]);
    });
  });
});

describe("hasSources / countSources", () => {
  it("hasSources reflects link state", () => {
    const Rel = relation("HasSources_Rel");
    const world = createWorld();
    const simple = register(world, archetype([QSSpec_Comp]));
    const storage = register(world, archetype([QSSpec_Comp], [Rel]));

    const target = spawn(simple);
    expect(hasSources(world, Rel, target)).toBe(false);

    const source = spawn(storage);
    link(world, source, Rel, target);
    expect(hasSources(world, Rel, target)).toBe(true);

    unlink(world, source, Rel);
    expect(hasSources(world, Rel, target)).toBe(false);
  });

  it("hasSources returns false on a stale target", () => {
    const Rel = relation("HasSourcesStale_Rel");
    const world = createWorld();
    const simple = register(world, archetype([QSSpec_Comp]));
    const storage = register(world, archetype([QSSpec_Comp, Rel]));

    const target = spawn(simple);
    spawn(storage, { HasSourcesStale_Rel: { target } });
    despawn(simple, target);

    expect(hasSources(world, Rel, target)).toBe(false);
  });

  it.each([
    { label: "a single source", sources: 1 },
    { label: "multiple sources", sources: 3 },
    { label: "no sources", sources: 0 },
  ])("countSources counts $label", ({ sources }) => {
    const Rel = relation(`CountSources_${sources}_Rel`);
    const world = createWorld();
    const simple = register(world, archetype([QSSpec_Comp]));
    const storage = register(world, archetype([QSSpec_Comp], [Rel]));

    const target = spawn(simple);
    for (let i = 0; i < sources; i++) {
      const source = spawn(storage);
      link(world, source, Rel, target);
    }

    expect(countSources(world, Rel, target)).toBe(sources);
  });

  it("countSources returns 0 on a stale target and decrements on unlink", () => {
    const Rel = relation("CountSourcesStale_Rel");
    const world = createWorld();
    const simple = register(world, archetype([QSSpec_Comp]));
    const storage = register(world, archetype([QSSpec_Comp], [Rel]));

    const target = spawn(simple);
    const source1 = spawn(storage);
    const source2 = spawn(storage);
    link(world, source1, Rel, target);
    link(world, source2, Rel, target);

    expect(countSources(world, Rel, target)).toBe(2);
    unlink(world, source1, Rel);
    expect(countSources(world, Rel, target)).toBe(1);

    despawn(simple, target);
    expect(countSources(world, Rel, target)).toBe(0);
  });
});

describe("reverse queries on unregistered relations", () => {
  /** World with one registered archetype and a live target entity, for relations that were never registered. */
  function unregisteredContext() {
    const world = createWorld();
    const simple = register(world, archetype([QSSpec_Comp]));
    const target = spawn(simple);
    return { world, target };
  }

  it("querySources does not crash and visits nothing", () => {
    const Unregistered = relation("QuerySourcesUnregistered");
    const { world, target } = unregisteredContext();

    let count = 0;
    querySources(world, Unregistered, target, () => {
      count += 1;
    });

    expect(count).toBe(0);
  });

  it("getSources returns an empty array", () => {
    const Unregistered = relation("GetSourcesUnregistered");
    const { world, target } = unregisteredContext();

    expect(getSources(world, Unregistered, target)).toStrictEqual([]);
  });

  it("hasSources returns false", () => {
    const Unregistered = relation("HasSourcesUnregistered");
    const { world, target } = unregisteredContext();

    expect(hasSources(world, Unregistered, target)).toBe(false);
  });

  it("countSources returns 0", () => {
    const Unregistered = relation("CountSourcesUnregistered");
    const { world, target } = unregisteredContext();

    expect(countSources(world, Unregistered, target)).toBe(0);
  });
});
