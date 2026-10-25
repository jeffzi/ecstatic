import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { shapeKey } from "../../../../src/plugin/optimizer/facts.js";
import { SPAWN_TIMEOUT_MS } from "../project.js";
import { CallbackProject, type Located, markOffset, nodeOffset } from "./callback-project.js";

/**
 * A spawn the hazard walker accepts: its target starts at `target`, and its key is the shape-guard
 * key of the storage the loop call after `loop` iterates.
 */
interface WantSpawn {
  readonly target: string;
  readonly loop: string;
}

/** A source whose first loop body spawns into storages of other shapes, with its accepted spawns. */
interface SpawnCase {
  readonly name: string;
  readonly source: string;
  readonly want: readonly WantSpawn[];
}

const ACCEPTED_SPAWN_CASES: readonly SpawnCase[] = [
  {
    name: "a spawn into a truthfully typed storage of another shape",
    source: `const ships = register(createWorld(), Ship);
each(enemies, () => {
	spawn(ships);
});
each(ships, () => {});`,
    want: [{ target: "ships);", loop: "each(ships" }],
  },
  {
    name: "a spawnMany into a truthfully typed storage of another shape",
    source: `import { spawnMany } from "../../src/ecstatic/index.js";
const ships = register(createWorld(), Ship);
each(enemies, () => {
	spawnMany(ships, 2);
});
each(ships, () => {});`,
    want: [{ target: "ships, 2", loop: "each(ships" }],
  },
  {
    name: "a spawn into a cast to a same-named component with other fields",
    source: `const Fake = archetype([component("Position", { z: 0 })]);
const lie = enemies as unknown as Storage<typeof Fake>;
each(enemies, () => {
	spawn(lie);
});
each(lie, () => {});`,
    want: [{ target: "lie);", loop: "each(lie" }],
  },
  {
    name: "a spawnMany into a cast to a same-named component with other fields",
    source: `import { spawnMany } from "../../src/ecstatic/index.js";
const Fake = archetype([component("Position", { z: 0 })]);
const lie = enemies as unknown as Storage<typeof Fake>;
each(enemies, () => {
	spawnMany(lie, 2);
});
each(lie, () => {});`,
    want: [{ target: "lie, 2", loop: "each(lie" }],
  },
  {
    name: "two spawns into storages of two other shapes",
    source: `const ships = register(createWorld(), Ship);
each(enemies, () => {
	spawn(ships);
	spawn(marked);
});
each(ships, () => {});
each(marked, () => {});`,
    want: [
      { target: "ships);", loop: "each(ships" },
      { target: "marked);", loop: "each(marked" },
    ],
  },
];

const UNREPORTED_SPAWN_CASES: readonly { name: string; source: string }[] = [
  {
    name: "a spawn whose target is a call",
    source: `const ships = register(createWorld(), Ship);
declare function pick(): typeof ships;
each(enemies, () => {
	spawn(pick());
});`,
  },
  {
    name: "a spawnMany whose target is a call",
    source: `import { spawnMany } from "../../src/ecstatic/index.js";
const ships = register(createWorld(), Ship);
declare function pick(): typeof ships;
each(enemies, () => {
	spawnMany(pick(), 2);
});`,
  },
  {
    name: "a spawn whose target holds a call",
    source: `const ships = register(createWorld(), Ship);
declare function tick(): void;
each(enemies, () => {
	spawn((tick(), ships));
});`,
  },
  {
    name: "a spawnMany whose target holds a call",
    source: `import { spawnMany } from "../../src/ecstatic/index.js";
const ships = register(createWorld(), Ship);
declare function tick(): void;
each(enemies, () => {
	spawnMany((tick(), ships), 2);
});`,
  },
  {
    name: "a spawn in a nested function body",
    source: `const ships = register(createWorld(), Ship);
each(enemies, () => {
	const later = () => spawn(ships);
	visit(later);
});`,
  },
  {
    name: "a spawnMany in a nested function body",
    source: `import { spawnMany } from "../../src/ecstatic/index.js";
const ships = register(createWorld(), Ship);
each(enemies, () => {
	const later = () => spawnMany(ships, 2);
	visit(later);
});`,
  },
];

const project = new CallbackProject(
  [],
  [
    ...ACCEPTED_SPAWN_CASES.map(({ source }) => source),
    ...UNREPORTED_SPAWN_CASES.map(({ source }) => source),
  ],
);

beforeAll(() => project.open(), SPAWN_TIMEOUT_MS);

afterAll(() => project.close());

/** The shape-guard key of the one storage the loop call after `mark` iterates. */
async function loopKey(located: Located, mark: string): Promise<string> {
  const { site } = await project.summarize(located, mark);
  const [shape] = site.shapes;
  if (shape === undefined || site.shapes.length !== 1) {
    throw new Error(`the loop call after ${mark} does not iterate one resolved shape`);
  }
  return shapeKey(shape);
}

describe("callback summary, when the body spawns into storages of other shapes", () => {
  it.each(ACCEPTED_SPAWN_CASES)(
    "reports each accepted spawn's target and claimed shape key, hazard-free, for $name",
    async ({ source, want }) => {
      const located = await project.viewCall(source);
      const wanted = await Promise.all(
        want.map(async ({ target, loop }) => ({
          offset: markOffset(located, target),
          key: await loopKey(located, loop),
        })),
      );

      const { callback, table } = await project.summarize(located);

      expect({
        spawns: callback.spawnTargets.map(({ node, key }) => ({
          offset: nodeOffset(table, node),
          key,
        })),
        hazards: callback.hazards,
      }).toStrictEqual({ spawns: wanted, hazards: [] });
    },
  );

  it.each(UNREPORTED_SPAWN_CASES)("reports no accepted spawn for $name", async ({ source }) => {
    const located = await project.viewCall(source);

    const { callback } = await project.summarize(located);

    expect(callback.spawnTargets).toStrictEqual([]);
  });
});
