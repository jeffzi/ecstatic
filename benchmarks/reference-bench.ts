/**
 * Reference ceilings: hand-inlined column loops, each the twin of an `each()` benchmark.
 *
 * Each benchmark here pairs with one in the iteration suite through the same
 * lifecycle helper — same world builder, same warmup, same `timedBench`
 * batching — and differs from it only in its timed body, the loop a
 * build-time optimizer would emit for that `each()` call. The gap between a
 * pair is what inlining that call site buys; these numbers are a ceiling to
 * compare against, not a regression target for the runtime.
 */

import { makeFrameWorld, makeThroughputWorld, warmedBench } from "./helpers.js";
import { registerBench } from "./runner.js";
import { frameInlined, throughputInlined } from "./systems.js";

// Twin of iteration/throughput.
registerBench(
  "reference/inlined_throughput",
  warmedBench(makeThroughputWorld, ({ trackedStorage }) => {
    throughputInlined(trackedStorage);
  }),
);

// Twin of iteration/frame.
registerBench("reference/inlined_frame", warmedBench(makeFrameWorld, frameInlined));
