import { join } from "node:path";

import {
  type ArrowFunction,
  type FunctionExpression,
  getTouchingPropertyName,
} from "typescript/ast";
import {
  isArrowFunction,
  isCallExpression,
  isFunctionExpression,
  isIdentifier,
} from "typescript/ast/is";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  hazardPoints,
  type HazardScope,
} from "../../../../src/plugin/optimizer/analysis/hazard.js";
import { PackageRoots } from "../../../../src/plugin/optimizer/analysis/roots.js";
import { resolveShapes } from "../../../../src/plugin/optimizer/analysis/shape.js";
import { isThisParameter } from "../../../../src/plugin/optimizer/analysis/syntax.js";
import { resolveSymbol } from "../../../../src/plugin/optimizer/compiler.js";
import type { ProjectView, Session } from "../../../../src/plugin/optimizer/session.js";
import {
  caseFiles,
  closeProject,
  openProject,
  projectPath,
  runtimeProject,
  SHARED_ARCHETYPE_FILES,
  SPAWN_TIMEOUT_MS,
} from "../project.js";

/** Opens every case file: the runtime API, the shared archetypes and components, and the values the cases use. */
const PRELUDE = `import { archetype, component, createWorld, each, getStorage, register, type Storage, type World } from "../../src/ecstatic/index.js";
import type { ArchetypeDescriptor, ComponentDescriptor } from "../../src/ecstatic/archetype.js";
import { Enemy, Hull, Linked, Ship } from "../archetypes.js";
import { Position } from "../position.js";
import { Velocity } from "../components.js";
declare global {
	interface Disposable {}
}
import {
	alive,
	countSources,
	despawn,
	despawnMany,
	destroyWorld,
	disable,
	disableMany,
	enable,
	enableMany,
	get,
	getResource,
	getSources,
	getTarget,
	has,
	hasAny,
	hasSources,
	link,
	resetResource,
	resource,
	set,
	setResource,
	spawn,
	spawnMany,
	unlink,
} from "../../src/ecstatic/index.js";
import { ChildOf, Shield, Stunned } from "../components.js";

declare function tag(strings: TemplateStringsArray): string;
declare function dec(value: unknown, context: unknown): void;
declare function make(): number;
declare const wide: Storage;
declare const maybe: object | undefined;
declare const loose: any;
class Stamp {
	at = 0;
}
class Box {
	get size(): number {
		return 1;
	}
	set size(value: number) {}
}
const box = new Box();
const plain = { size: 1 };
const visited: number[] = [];
const table = new Map<string, number>();
const stamp = new Stamp();
const Score = resource("Score", { value: 0, nested: { deep: { n: 0 } }, list: [0], table, stamp });
const world = createWorld();
let total = 0;
const enemies = register(createWorld(), Enemy);
const ships = register(createWorld(), Ship);
const hulls = register(createWorld(), Hull);
`;

/** A module whose first `each` call passes an inline callback. */
interface HazardFreeCase {
  readonly name: string;
  readonly source: string;
}

/** A module whose first `each` callback holds a hazard point at the first occurrence of each mark. */
interface HazardCase extends HazardFreeCase {
  readonly marks: readonly string[];
}

/** A spawn whose target's shape differs from the iterated one. */
const SPAWN_ELSEWHERE: HazardFreeCase = {
  name: "spawn into a storage of another shape",
  source: `each(enemies, () => {
	spawn(ships, { Position: { x: 1 } });
	spawnMany(ships, 2);
});`,
};

const HAZARD_FREE_CASES: readonly HazardFreeCase[] = [
  {
    name: "operators on primitive view fields and locals",
    source: `each(enemies, (e) => {
	e.Position.x += e.Velocity.dx * 2;
	const id = e.id;
	if (e.Position.x > 0 && !e.Velocity.dy) {
		e.Position.y = -e.Position.y;
	}
	total += id > 0 ? 1 : 0;
});`,
  },
  {
    name: "global Math methods",
    source: `each(enemies, (e) => {
	e.Position.x = Math.max(e.Position.x, Math.abs(e.Velocity.dx));
});`,
  },
  {
    name: "non-growing ecstatic ops with data-only arguments",
    source: `each(enemies, (e) => {
	if (has(enemies, e.id, Shield)) {
		disable(enemies, e.id, Shield);
	}
	enable(enemies, e.id, Shield, { hp: get(enemies, e.id, Position.x) });
	set(enemies, e.id, Position, { x: 1 });
	despawn(enemies, e.id);
});`,
  },
  SPAWN_ELSEWHERE,
  {
    name: "a class whose evaluated parts are hazard-free",
    source: `each(enemies, () => {
	class Local {
		static count = 0;
		static {
			Local.count = 1;
		}
		["key"] = make();
		method(): void {
			visited.push(make());
		}
	}
	total += Local.count;
});`,
  },
  {
    name: "destructuring defaults that are literals",
    source: `each(enemies, ({ Position: { x = 0 } }) => {
	const { size = 2 } = plain;
	total += x + size;
});`,
  },
  {
    name: "functions created but not called",
    source: `each(enemies, (e) => {
	const later = () => visited.push(e.id);
	function never(): Date {
		return new Date();
	}
	const holder = { get value(): number { return make(); }, later, never };
});`,
  },
  {
    name: "operators that never convert an object",
    source: `each(enemies, () => {
	const held = maybe ?? plain;
	const same = held === plain || !held;
	total += same && typeof held === "object" ? 1 : 0;
});`,
  },
  {
    name: "view uses through parentheses, non-null assertions, and string keys on an any-typed view",
    source: `each(enemies, (e: any) => {
	total = (e).Position.x;
	total = (e.Position).x;
	total = (e).id;
	total = e["Position"].x;
	total = e.Position.x;
	total = e.Position!.x;
	total = e.id;
});`,
  },
  {
    name: "the other non-growing ecstatic ops with data-only arguments",
    source: `each(enemies, (e) => {
	total += hasAny(enemies, e.id, [Shield, Stunned]) ? 1 : 0;
	total += alive(enemies, e.id) ? 1 : 0;
	enableMany(enemies, [e.id], { Stunned: true });
	enable(enemies, e.id, { Shield: { hp: 1 }, Stunned: true });
	disableMany(enemies, [e.id], [Shield]);
	const target = getTarget(world, e.id, ChildOf);
	unlink(world, e.id, ChildOf);
	link(world, e.id, ChildOf, e.id, { order: 1 });
	total += getResource(world, Score).value;
	setResource(world, Score, { value: 1, nested: { deep: { n: 2 } } });
	resetResource(world, Score);
	total += getSources(world, ChildOf, e.id).length + countSources(world, ChildOf, e.id);
	total += hasSources(world, ChildOf, e.id) ? 1 : 0;
	despawnMany(enemies, [e.id]);
});`,
  },
  {
    name: "lowered presence tests and comparisons of slots with undefined and null",
    source: `each(enemies, (e) => {
	if (e.Shield == null) total += 1;
	if (e.Shield != null && e.Shield !== undefined) total += 2;
	if (e.Shield === undefined || e.Position == undefined) total += 3;
	if (!e.Shield || e.Shield === null || e.Position !== null) total += 4;
	total += e.Shield ?? total > 0 ? 1 : 0;
	while (e.Shield) disable(enemies, e.id, Shield);
});`,
  },
  {
    name: "element access and computed keys with primitive keys",
    source: `each(enemies, () => {
	total += visited[0] ?? 0;
	const keyed = { ["size"]: visited[total] };
	total += keyed.size ?? 0;
});`,
  },
  {
    name: "destructuring with string and numeric keys",
    source: `each(enemies, () => {
	const { "size": size } = plain;
	const { 0: first } = visited;
	total += size + (first ?? 0);
});`,
  },
  {
    name: "element access with a primitive key on a union receiver",
    source: `declare const scores: number[] | readonly number[];
each(enemies, () => {
	const read = scores[total];
});`,
  },
  {
    name: "setResource whose value holds functions and unions of plain objects",
    source: `declare const deeper: { deep: { n: number } } | { deep: { n: 1 } };
const Hooks = resource("Hooks", { run: (): number => 0 });
each(enemies, () => {
	setResource(world, Score, { nested: deeper });
	setResource(world, Hooks, { run: () => 1 });
});`,
  },
];

const HAZARD_CASES: readonly HazardCase[] = [
  {
    name: "calls of user functions",
    source: `each(enemies, (e) => {
	visited.push(e.id);
	total += make();
});`,
    marks: ["visited.push(e.id)", "make()"],
  },
  {
    name: "Math shadowed by a local",
    source: `const Math = { max: (a: number, b: number): number => a + b };
each(enemies, () => {
	total = Math.max(1, 2);
});`,
    marks: ["Math.max(1, 2)"],
  },
  {
    name: "spawn into the iterated shape or an unresolved one",
    source: `each(ships, () => {
	spawn(hulls);
	spawnMany(ships, 2);
	spawn(wide);
});`,
    marks: ["spawn(hulls)", "spawnMany(ships, 2)", "spawn(wide)"],
  },
  {
    name: "ecstatic ops outside the allowlist",
    source: `each(enemies, () => {
	register(createWorld(), Ship);
	each(ships, () => {});
});`,
    marks: ["register(createWorld(), Ship)", "createWorld(), Ship", "each(ships"],
  },
  {
    name: "ops whose object argument runs a getter at the depth they read it",
    source: `each(enemies, (e) => {
	set(enemies, e.id, Position, { get x() { return 1; } });
	spawn(ships, { Position: { get x() { return 2; } } });
});`,
    marks: ["set(enemies", "spawn(ships"],
  },
  {
    name: "enable whose values or record form run a getter at the depth it reads them",
    source: `each(enemies, (e) => {
	enable(enemies, e.id, Shield, { get hp() { return 1; } });
	enable(enemies, e.id, { Shield: { get hp() { return 2; } } });
});`,
    marks: ["enable(enemies, e.id, Shield", "enable(enemies, e.id, {"],
  },
  {
    name: "setResource whose value runs user code at any depth",
    source: `each(enemies, () => {
	setResource(world, Score, { nested: { deep: { get n() { return 1; } } } });
	setResource(world, Score, { list: visited });
	setResource(world, Score, { table });
	setResource(world, Score, { stamp });
});`,
    marks: [
      "setResource(world, Score, { nested",
      "setResource(world, Score, { list",
      "setResource(world, Score, { table",
      "setResource(world, Score, { stamp",
    ],
  },
  {
    name: "destroying a world",
    source: `each(enemies, () => {
	destroyWorld(world);
});`,
    marks: ["destroyWorld(world)"],
  },
  {
    name: "construction, iteration, spread, and type tests",
    source: `each(enemies, () => {
	const made = new Box();
	const text = tag\`x\`;
	for (const v of visited) total += v;
	const copy = [...visited];
	const merged = { ...plain };
	const [first] = visited;
	let second: number | undefined = 0;
	[second] = visited;
	const isBox = made instanceof Box;
	const hasSize = "size" in plain;
});`,
    marks: [
      "new Box()",
      "tag`x`",
      "for (const v of",
      "...visited",
      "...plain",
      "[first]",
      "[second] =",
      "made instanceof",
      `"size" in`,
    ],
  },
  {
    name: "accessors and object operands",
    source: `each(enemies, () => {
	total = box.size;
	box.size = 2;
	const { size } = box;
	total = +plain;
	const label = \`\${plain}\`;
	total += visited[loose] ?? 0;
	const keyed = { [loose]: 1 };
});`,
    marks: [
      "box.size;",
      "box.size = 2",
      "size } = box",
      "+plain",
      "plain}`",
      "visited[loose]",
      "loose]: 1",
    ],
  },
  {
    name: "decorators and using",
    source: `each(enemies, () => {
	@dec
	class Marked {}
	using held = null;
});`,
    marks: ["@dec", "using held"],
  },
  {
    name: "class evaluation code",
    source: `each(enemies, () => {
	class Counted {
		static made = make();
		static {
			visited.push(1);
		}
		[String(total)](): void {
			visited.push(2);
		}
	}
});`,
    marks: ["make();", "visited.push(1)", "String(total)"],
  },
  {
    name: "defaults that call",
    source: `each(enemies, ({ Position: { x = make() } }) => {
	const { size = make() } = plain;
	total += x + size;
});`,
    marks: ["make() } })", "make() } ="],
  },
  {
    name: "private names, whose reads are not resolved statically",
    source: `each(enemies, () => {
	class Counter {
		static #count = 0;
		static {
			Counter.#count += 1;
		}
	}
});`,
    marks: ["Counter.#count"],
  },
  {
    name: "destructuring a rest or a computed key",
    source: `each(enemies, () => {
	const { ...rest } = plain;
	const { ["size"]: size } = plain;
});`,
    marks: ["...rest", `["size"]: size`],
  },
  {
    name: "reads and op arguments typed any",
    source: `each(enemies, (e) => {
	const read: number = loose[total];
	set(enemies, e.id, Position, loose);
	setResource(world, Score, loose);
});`,
    marks: ["loose[total]", "set(enemies", "setResource(world"],
  },
  {
    name: "calls the checker cannot resolve, through parentheses, and of runtime functions outside the ops",
    source: `import { assertShape } from "../../src/ecstatic/shape-guard.js";
each(enemies, (e) => {
	loose.run();
	(has)(enemies, e.id, Shield);
	assertShape(enemies, "key");
});`,
    marks: ["loose.run()", "loose.run", "(has)(enemies", "assertShape(enemies"],
  },
  {
    name: "a spawn without its storage",
    source: `each(ships, () => {
	// @ts-expect-error -- a spawn without its storage still parses, and its call stays a hazard
	spawn();
});`,
    marks: ["spawn();"],
  },
];

const CASES: readonly HazardFreeCase[] = [...HAZARD_FREE_CASES, ...HAZARD_CASES];

const CASE_STEM = "app/case/case";

let root = "";
let session: Session;
let view: ProjectView;
const roots = new PackageRoots();

beforeAll(async () => {
  ({ root, session, view } = await openProject(
    runtimeProject({
      ...SHARED_ARCHETYPE_FILES,
      ...caseFiles(
        CASE_STEM,
        CASES.map(({ source }) => source),
        PRELUDE,
      ),
    }),
  ));
}, SPAWN_TIMEOUT_MS);

afterAll(() => closeProject(session));

interface Located {
  readonly scope: HazardScope;
  readonly callback: ArrowFunction | FunctionExpression;
}

/**
 * Locates the inline callback of the first `each` call in a case.
 *
 * @param source - The source of the case to search.
 * @returns The callback, with the scope that call gives it: the shapes its storages resolve to and
 *   the symbol of its view parameter.
 * @throws Error when the case holds no `each` call, the call passes no storages or callback, or the
 *   callback is not inline.
 */
async function callbackIn(source: string): Promise<Located> {
  const file = await view.sourceFile(
    projectPath(root, `${CASE_STEM}${CASES.findIndex((c) => c.source === source)}.ts`),
  );
  const call = getTouchingPropertyName(file, file.text.indexOf("each(", PRELUDE.length)).parent;
  if (!isCallExpression(call)) throw new Error(`${source} holds no each call`);
  const [storages, callback] = call.arguments;
  if (storages === undefined || callback === undefined)
    throw new Error(`${source} passes no storages or callback`);
  if (!(isArrowFunction(callback) || isFunctionExpression(callback))) {
    throw new Error(`${source} passes no inline callback`);
  }
  const first = callback.parameters.find((param) => !isThisParameter(param));
  const [{ shapes }, symbol] = await Promise.all([
    resolveShapes(view.checker, storages),
    first !== undefined && isIdentifier(first.name)
      ? resolveSymbol(view.checker, first.name)
      : undefined,
  ]);
  return { callback, scope: { checker: view.checker, roots, shapes, view: symbol } };
}

/** The offsets in the case file holding `source` of the first occurrence in `source` of each mark. */
function markOffsets(source: string, marks: readonly string[]): number[] {
  return marks.map((mark) => {
    const at = source.indexOf(mark);
    if (at < 0) throw new Error(`${JSON.stringify(mark)} is not in the case source`);
    return PRELUDE.length + at;
  });
}

describe("hazardPoints", () => {
  it.each(HAZARD_FREE_CASES)("records no hazard point for $name", async ({ source }) => {
    const { scope, callback } = await callbackIn(source);

    const { points } = await hazardPoints(scope, callback);

    expect(points).toStrictEqual([]);
  });

  it.each(HAZARD_CASES)(
    "records each node that can run user code for $name",
    async ({ source, marks }) => {
      const { scope, callback } = await callbackIn(source);

      const { points } = await hazardPoints(scope, callback);

      expect(points.map((node) => node.getStart())).toStrictEqual(markOffsets(source, marks));
    },
  );

  it("lists the declaration files a spawn target's shape consulted", async () => {
    const { scope, callback } = await callbackIn(SPAWN_ELSEWHERE.source);

    const { declarationFiles } = await hazardPoints(scope, callback);

    expect(declarationFiles).toStrictEqual(
      expect.arrayContaining([join(root, "app", "archetypes.ts")]),
    );
  });
});
