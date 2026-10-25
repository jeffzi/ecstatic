/**
 * Random-access reads and writes: `get`/`set` against N shuffled entity IDs.
 *
 * Every body is net-neutral — it reads or overwrites fields without changing
 * the population — so the world is built once per bench and reused across
 * every sample.
 */

import { get, set } from "ecstatic";

import { Position, Velocity } from "./archetypes.js";
import { benchCreateWorld, warmedBench } from "./helpers.js";
import { registerBench } from "./runner.js";

let sink = 0;

/**
 * Accumulated result of every read, kept live so V8 cannot elide the loads.
 *
 * @returns The running sum so far; meaningless as a number, returned only so the accumulated work
 * stays reachable.
 */
export function sinkValue(): number {
  return sink;
}

registerBench(
  "access/get_1field",
  warmedBench(benchCreateWorld, ({ n, trackedStorage: storage, tracked }) => {
    for (let i = 0; i < n; i++) {
      // oxlint-disable-next-line typescript/no-non-null-assertion -- i < n = tracked.length
      sink += get(storage, tracked[i]!, Position.x);
    }
  }),
);

registerBench(
  "access/get_2field",
  warmedBench(benchCreateWorld, ({ n, trackedStorage: storage, tracked }) => {
    for (let i = 0; i < n; i++) {
      // oxlint-disable-next-line typescript/no-non-null-assertion -- i < n = tracked.length
      const id = tracked[i]!;
      const x = get(storage, id, Position.x);
      const y = get(storage, id, Position.y);
      sink += x + y;
    }
  }),
);

registerBench(
  "access/get_4field",
  warmedBench(benchCreateWorld, ({ n, trackedStorage: storage, tracked }) => {
    for (let i = 0; i < n; i++) {
      // oxlint-disable-next-line typescript/no-non-null-assertion -- i < n = tracked.length
      const id = tracked[i]!;
      const x = get(storage, id, Position.x);
      const y = get(storage, id, Position.y);
      const dx = get(storage, id, Velocity.dx);
      const dy = get(storage, id, Velocity.dy);
      sink += x + y + dx + dy;
    }
  }),
);

registerBench(
  "access/set_1field",
  warmedBench(benchCreateWorld, ({ n, trackedStorage: storage, tracked }) => {
    for (let i = 0; i < n; i++) {
      // oxlint-disable-next-line typescript/no-non-null-assertion -- i < n = tracked.length
      set(storage, tracked[i]!, Position.x, i + 1);
    }
  }),
);

registerBench(
  "access/set_record",
  warmedBench(benchCreateWorld, ({ n, trackedStorage: storage, tracked }) => {
    for (let i = 0; i < n; i++) {
      const value = i + 1;
      // oxlint-disable-next-line typescript/no-non-null-assertion -- i < n = tracked.length
      set(storage, tracked[i]!, Position, { x: value, y: value * 2 });
    }
  }),
);
