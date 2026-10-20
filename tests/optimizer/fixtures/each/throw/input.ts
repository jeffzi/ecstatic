// rewrite-applies: throw
import { archetype, component, createWorld, each, register, spawn } from "ecstatic";

const Fuse = component("SparkFuse", { x: 0 });

/**
 * Throws from the body on the second row, which leaves the loop: the rows after it never run.
 *
 * @returns How many rows ran and the constructor name of the error that left the loop.
 */
export function scenario(): unknown {
  const storage = register(createWorld(), archetype([Fuse]));
  for (const x of [1, 2, 3]) {
    spawn(storage, { SparkFuse: { x } });
  }
  const seen: number[] = [];
  let thrown = "none";

  try {
    each(storage, (e) => {
      seen.push(e.SparkFuse.x);
      if (seen.length === 2) throw new RangeError("stop");
    });
  } catch (error) {
    thrown = error instanceof Error ? error.constructor.name : typeof error;
  }

  return { seen, thrown };
}
