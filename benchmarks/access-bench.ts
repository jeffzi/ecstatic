/**
 * Random-access reads and writes: `get`/`set` against N shuffled entity IDs.
 *
 * Every body is net-neutral — it reads or overwrites fields without changing
 * the population — so the world is built once per bench and reused across
 * every sample, letting mitata batch for its best resolution.
 */

import { destroyWorld, get, set } from "ecstatic";

import { Position, Velocity } from "./archetypes.js";
import { benchCreateWorld } from "./helpers.js";
import { registerBench } from "./runner.js";

let sink = 0;

/** Accumulated result of every read, kept live so V8 cannot elide the loads. */
export function sinkValue(): number {
  return sink;
}

registerBench("access.get_1field", function* () {
  const { world, n, trackedStorage: storage, tracked } = benchCreateWorld();

  yield () => {
    for (let i = 0; i < n; i++) {
      sink += get(storage, tracked[i]!, Position.x);
    }
  };

  destroyWorld(world);
});

registerBench("access.get_2field", function* () {
  const { world, n, trackedStorage: storage, tracked } = benchCreateWorld();

  yield () => {
    for (let i = 0; i < n; i++) {
      const id = tracked[i]!;
      const x = get(storage, id, Position.x);
      const y = get(storage, id, Position.y);
      sink += x + y;
    }
  };

  destroyWorld(world);
});

registerBench("access.get_4field", function* () {
  const { world, n, trackedStorage: storage, tracked } = benchCreateWorld();

  yield () => {
    for (let i = 0; i < n; i++) {
      const id = tracked[i]!;
      const x = get(storage, id, Position.x);
      const y = get(storage, id, Position.y);
      const dx = get(storage, id, Velocity.dx);
      const dy = get(storage, id, Velocity.dy);
      sink += x + y + dx + dy;
    }
  };

  destroyWorld(world);
});

registerBench("access.set_1field", function* () {
  const { world, n, trackedStorage: storage, tracked } = benchCreateWorld();

  yield () => {
    for (let i = 0; i < n; i++) {
      set(storage, tracked[i]!, Position.x, i + 1);
    }
  };

  destroyWorld(world);
});

registerBench("access.set_record", function* () {
  const { world, n, trackedStorage: storage, tracked } = benchCreateWorld();

  yield () => {
    for (let i = 0; i < n; i++) {
      const value = i + 1;
      set(storage, tracked[i]!, Position, { x: value, y: value * 2 });
    }
  };

  destroyWorld(world);
});
