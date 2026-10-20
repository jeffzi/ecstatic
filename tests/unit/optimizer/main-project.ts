/**
 * The shared fixture project of the rewrite tests: the runtime, two component files, and a main
 * file with two `each` calls that inline and one that bails.
 */
import type { Position } from "../../../src/plugin/optimizer/facts.js";
import { locate } from "./locate.js";
import { projectPath, runtimeProject } from "./project.js";

export const COMPONENTS_FILE = "app/components.ts";
export const HEALTH_FILE = "app/health.ts";
export const MAIN_FILE = "app/main.ts";

/** The runtime source a rewritten file's `DEBUG` copy is taken from, under its package root. */
export const DEBUG_FILE = "src/ecstatic/debug.ts";

const COMPONENTS_SOURCE = `import { component } from "../src/ecstatic/index.js";

export const Position = component("Position", { x: 0, y: 0 });
export const Velocity = component("Velocity", { dx: 0, dy: 0 });
`;

const HEALTH_SOURCE = `import { component } from "../src/ecstatic/index.js";

export const Health = component("Health", { hp: 0 });
`;

/**
 * Calls `each` over two storages whose shapes consult different files, both calls compiling to
 * inlined loops.
 */
const INLINED_SOURCE = `import { archetype, each, type Storage } from "../src/ecstatic/index.js";
import { Position, Velocity } from "./components.js";
import { Health } from "./health.js";

const Mover = archetype([Position, Velocity]);
const Statue = archetype([Position, Health]);
declare const movers: Storage<typeof Mover>;
declare const statues: Storage<typeof Statue>;

each(movers, (e) => {
    e.Position.x += e.Velocity.dx;
});
each(statues, (e) => {
    e.Health.hp = 0;
});
`;

/** {@link INLINED_SOURCE} calling `each` once more, with an async callback. */
export const MAIN_SOURCE = `${INLINED_SOURCE}each(movers, async (e) => {
    e.Position.y += e.Velocity.dy;
});
`;

/** The `each` call of {@link MAIN_SOURCE} that the async callback bails. */
export const ASYNC_CALL = "each(movers, async";

/** The first `each` call of {@link MAIN_SOURCE} that compiles to an inlined loop. */
export const MOVERS_CALL = "each(movers, (e)";

/** The second `each` call of {@link MAIN_SOURCE} that compiles to an inlined loop. */
export const STATUES_CALL = "each(statues";

/**
 * The runtime project with `main` as `app/main.ts`, beside the component files it imports.
 *
 * @param extra - Files added to the project, keyed by slash-separated path.
 * @returns The project's files keyed by slash-separated path.
 */
export function mainProject(extra: Readonly<Record<string, string>> = {}): Record<string, string> {
  return runtimeProject({
    [COMPONENTS_FILE]: COMPONENTS_SOURCE,
    [HEALTH_FILE]: HEALTH_SOURCE,
    [MAIN_FILE]: MAIN_SOURCE,
    ...extra,
  });
}

/** The position of the first occurrence of `call` in {@link MAIN_SOURCE}, in the project at `root`. */
export function callPosition(root: string, call: string): Position {
  return locate(projectPath(root, MAIN_FILE), MAIN_SOURCE, call);
}
