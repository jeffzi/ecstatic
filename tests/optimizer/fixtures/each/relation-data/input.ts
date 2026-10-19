// rewrite-applies: read-required-field
// rewrite-applies: write-required-field
// rewrite-applies: read-optional-field
// rewrite-applies: write-optional-field
// rewrite-applies: optional-chain-read
// rewrite-applies: relation-data-field
import { archetype, component, createWorld, each, get, register, relation, spawn } from "ecstatic";

const Post = component("MooringPost", { x: 0 });
const Rope = relation("MooringRope", { slack: 0 });
const Chain = relation("MooringChain", { length: 0 });

/**
 * Reads and writes the data fields of a required and an optional relation slot, on a row whose optional
 * relation is linked and on one where it is not.
 *
 * @returns What the body read, and the relation fields after the loop.
 */
export function scenario(): unknown {
  const world = createWorld();
  const post = spawn(register(world, archetype([Post])), { MooringPost: { x: 0 } });
  const storage = register(world, archetype([Post, Rope], [Chain]));
  const moored = spawn(storage, {
    MooringRope: { target: post, slack: 2 },
    MooringChain: { target: post, length: 4 },
  });
  const loose = spawn(storage, { MooringRope: { target: post, slack: 5 } });
  const trace: unknown[] = [];

  each(storage, (e) => {
    e.MooringRope.slack += 1;
    trace.push(e.MooringRope.slack, e.MooringChain?.length);
    // oxlint-disable-next-line typescript/strict-boolean-expressions -- testing an optional relation slot is the lowering under test
    if (e.MooringChain) {
      e.MooringChain.length *= 2;
      trace.push(e.MooringChain.length);
    }
  });

  return {
    trace,
    slack: [moored, loose].map((id) => get(storage, id, Rope.slack)),
    length: get(storage, moored, Chain.length),
  };
}
