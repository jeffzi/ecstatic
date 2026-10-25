// rewrite-applies: block-scoped-declaration
// rewrite-applies: closure
// rewrite-applies: return-in-nested-function
import { archetype, component, createWorld, each, register, spawn } from "ecstatic";

const Seed = component("GardenSeed", { x: 0 });

/**
 * Declares `let`, `const`, class, and function bindings in the body, which are fresh on every row, with closures
 * that capture that row's bindings, and nested functions whose own returns are untouched.
 *
 * @returns What the closures read once the loop is done, then what the nested functions returned, in visit order.
 */
export function scenario(): unknown {
  const storage = register(createWorld(), archetype([Seed]));
  for (const x of [1, 2, 3]) {
    spawn(storage, { GardenSeed: { x } });
  }
  const readers: (() => unknown)[] = [];
  const results: number[] = [];

  each(storage, (e) => {
    const x = e.GardenSeed.x;
    let doubled = x * 2;
    class Tag {
      readonly value = x;
    }
    function read(): unknown {
      return [x, doubled, new Tag().value];
    }
    const half = {
      of(v: number): number {
        return v / 2;
      },
    };
    const triple = (v: number): number => {
      return v * 3;
    };
    readers.push(read, () => doubled);
    results.push(half.of(x), triple(x));
    doubled += 100;
  });

  return { reads: readers.map((reader) => reader()), results };
}
