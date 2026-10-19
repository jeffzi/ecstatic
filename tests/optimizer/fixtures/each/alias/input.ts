// rewrite-applies: alias
// rewrite-applies: non-null-slot
import {
  archetype,
  component,
  createWorld,
  disable,
  each,
  enable,
  get,
  register,
  spawn,
} from "ecstatic";

const Body = component("KeepBody", { x: 0 });
const Wall = component("KeepWall", { hp: 0 });

/** The constructor name of `error`, or its type when it is no `Error`. */
function nameOf(error: unknown): string {
  return error instanceof Error ? error.constructor.name : typeof error;
}

/**
 * Holds slots in constants, which test presence once at the declaration: after a later `disable()` in the same
 * row, the held optional's fields still reach its columns, and a non-null alias of a disabled slot throws at the
 * field read.
 *
 * @returns What the body read, with the constructor name of each error a field read threw, and each row's fields
 * after the loop.
 */
export function scenario(): unknown {
  const storage = register(createWorld(), archetype([Body], [Wall]));
  const walled = spawn(storage, { KeepBody: { x: 1 }, KeepWall: { hp: 5 } });
  const open = spawn(storage, { KeepBody: { x: 2 } });
  const trace: unknown[] = [];

  each(storage, (e) => {
    const wall = e.KeepWall;
    const body = e.KeepBody;
    body.x = body.x + 1;
    trace.push(wall?.hp);
    // oxlint-disable-next-line typescript/strict-boolean-expressions -- testing a held optional slot is the lowering under test
    if (wall) {
      disable(storage, e.id, Wall);
      wall.hp += 1;
      // oxlint-disable-next-line typescript/no-unnecessary-condition -- comparing a held optional slot is the lowering under test
      trace.push(wall.hp, wall === undefined, wall == null, e.KeepWall === undefined, body.x);
    } else {
      // oxlint-disable-next-line typescript/strict-boolean-expressions, typescript/no-unnecessary-condition -- testing a held optional slot is the lowering under test
      trace.push("open", wall === undefined, !wall);
    }
    // oxlint-disable-next-line typescript/no-non-null-assertion -- a non-null alias of a disabled slot is the read under test
    const held = e.KeepWall!;
    try {
      trace.push(held.hp);
    } catch (error) {
      trace.push(nameOf(error));
    }
  });

  enable(storage, walled, Wall);
  return {
    trace,
    hp: get(storage, walled, Wall.hp),
    xs: [walled, open].map((id) => get(storage, id, Body.x)),
  };
}
