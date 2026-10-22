import { archetype, component, createWorld, each, register, spawn, type Storage } from "ecstatic";

const Real = component("DivergentReal", { a: 0 });
const Claimed = component("DivergentClaimed", { b: 0 });

const RealShape = archetype([Real]);
const ClaimedShape = archetype([Claimed]);

/**
 * Walks a storage of `rows` rows through a cast that claims a shape the storage does not have.
 *
 * @param rows - How many rows the storage holds when the walk runs.
 * @param visited - Receives the id of every row the walk visits, in visit order.
 */
export function visit(rows: number, visited: number[]): void {
  const storage = register(createWorld(), RealShape);
  for (let k = 0; k < rows; k++) {
    spawn(storage, { DivergentReal: { a: k } });
  }
  const lying = storage as unknown as Storage<typeof ClaimedShape>;

  each(lying, (e) => {
    visited.push(e.id);
  });
}
