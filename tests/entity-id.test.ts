import { describe, expect, it } from "vitest";

import {
  assertEntityIndex,
  entityGen,
  entityIndex,
  initialEntityId,
  MAX_GEN,
  MAX_INDEX,
} from "../src/entity-id.js";

describe("generational IDs", () => {
  it("uses 24 index bits and the remaining safe integer budget for generations", () => {
    expect(MAX_INDEX).toBe(16777216);
    expect(MAX_GEN).toBe(536870912);
  });

  const roundTripCases: [number, number][] = [
    [0, 1],
    [1, 1],
    [255, 15],
    [1000, 42],
    [MAX_INDEX - 1, 1],
    [MAX_INDEX - 1, MAX_GEN - 1],
  ];

  it.each(roundTripCases)("round-trips index=%d gen=%d", (index, gen) => {
    const eid = gen * MAX_INDEX + index;
    expect(entityIndex(eid)).toBe(index);
    expect(entityGen(eid)).toBe(gen);
  });

  it("initial_entity_id packs gen=1 for a fresh slot", () => {
    const index = 42;
    const eid = initialEntityId(index);
    expect(entityIndex(eid)).toBe(index);
    expect(entityGen(eid)).toBe(1);
  });

  it("gen advance adds MAX_INDEX to the packed ID", () => {
    const index = 42;
    const eid1 = initialEntityId(index); // gen=1
    const eid2 = eid1 + MAX_INDEX; // gen=2
    expect(entityIndex(eid2)).toBe(index);
    expect(entityGen(eid2)).toBe(2);
  });

  it("rejects fresh entity indices at the derived index limit", () => {
    expect(() => {
      assertEntityIndex(MAX_INDEX - 1);
    }).not.toThrow();

    expect(() => {
      assertEntityIndex(MAX_INDEX);
    }).toThrow(new RegExp(String(MAX_INDEX - 1)));
  });
});
