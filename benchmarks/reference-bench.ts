/**
 * Reference ceilings: hand-fused column loops, each the twin of an `each()` benchmark.
 *
 * Each benchmark here pairs with one in the iteration suite through the same
 * lifecycle helper — same world builder, same warmup, same `timedBench`
 * batching — and differs from it only in its timed body, the loop a
 * compile-time transform would emit for that `each()` call. The gap between a pair is what fusing that call site buys;
 * these numbers are a ceiling to compare against, not a regression target for
 * the runtime.
 */

import { frameBench, throughputBench } from "./helpers.js";
import { registerBench } from "./runner.js";
import { frameFused, throughputFused } from "./systems.js";

/**
 * This suite's term of the sum `main.ts` feeds to `do_not_optimize`.
 *
 * The fused bodies write columns and accumulate nothing, so the term is always 0. The function
 * exists so `main.ts` imports this module, and so registers its benchmarks, the way it imports
 * every other suite.
 *
 * @returns 0.
 */
export function sinkValue(): number {
  return 0;
}

// Twin of iteration/throughput.
registerBench("reference/fused_throughput", throughputBench(throughputFused));

// Twin of iteration/frame.
registerBench("reference/fused_frame", frameBench(frameFused));
