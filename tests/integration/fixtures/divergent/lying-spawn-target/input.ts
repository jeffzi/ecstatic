import {
  archetype,
  component,
  createWorld,
  each,
  get,
  register,
  spawn,
  spawnMany,
  type EntityId,
  type Storage,
} from "ecstatic";

import type { TwinShape } from "./twin.js";

const Spot = component("LyingSpot", { x: 0 });
const Other = component("LyingOther", { y: 0 });

const SpotShape = archetype([Spot]);
const OtherShape = archetype([Other]);

/** What a walk left: the message of the error it threw, each original row's `x`, and each storage's row count. */
export interface Outcome {
  readonly error: string | undefined;
  readonly xs: number[];
  readonly rows: number;
  readonly others: number;
}

/** A storage of two rows whose `x` is 1, then 2, the ids of those rows, and an empty storage of another shape. */
function setup(): {
  storage: Storage<typeof SpotShape>;
  others: Storage<typeof OtherShape>;
  ids: EntityId[];
} {
  const world = createWorld();
  const storage = register(world, SpotShape);
  const others = register(world, OtherShape);
  const ids = [spawn(storage, { LyingSpot: { x: 1 } }), spawn(storage, { LyingSpot: { x: 2 } })];
  return { storage, others, ids };
}

/**
 * Runs `walk`, catching what it throws.
 *
 * @param storage - The storage `walk` iterates.
 * @param others - The storage of another shape `walk` may spawn into.
 * @param ids - The ids of the rows of `storage` before the walk.
 * @param walk - The walk.
 * @returns What the walk left.
 */
function outcome(
  storage: Storage<typeof SpotShape>,
  others: Storage<typeof OtherShape>,
  ids: readonly EntityId[],
  walk: () => void,
): Outcome {
  let error: string | undefined;
  try {
    walk();
  } catch (caught) {
    error = caught instanceof Error ? caught.message : "thrown";
  }
  return {
    error,
    xs: ids.map((id) => get(storage, id, Spot.x)),
    rows: storage.n,
    others: others.n,
  };
}

/** Spawns through a cast that claims another shape for the iterated storage, between two writes of each row. */
export function spawnThroughLie(): Outcome {
  const { storage, others, ids } = setup();
  const lie = storage as unknown as Storage<typeof OtherShape>;
  return outcome(storage, others, ids, () => {
    each(storage, (e) => {
      e.LyingSpot.x += 100;
      spawn(lie);
      e.LyingSpot.x += 1000;
    });
  });
}

/** Spawns many rows through a cast that claims another shape for the iterated storage, between two writes of each row. */
export function spawnManyThroughLie(): Outcome {
  const { storage, others, ids } = setup();
  const lie = storage as unknown as Storage<typeof OtherShape>;
  return outcome(storage, others, ids, () => {
    each(storage, (e) => {
      e.LyingSpot.x += 100;
      spawnMany(lie, 1);
      e.LyingSpot.x += 1000;
    });
  });
}

/** Spawns through a cast that claims another shape for the iterated storage on the second row visited only, after the first row finished. */
export function spawnThroughLieOnLaterRow(): Outcome {
  const { storage, others, ids } = setup();
  const lie = storage as unknown as Storage<typeof OtherShape>;
  return outcome(storage, others, ids, () => {
    each(storage, (e) => {
      e.LyingSpot.x += 100;
      if (e.LyingSpot.x === 101) spawn(lie);
      e.LyingSpot.x += 1000;
    });
  });
}

/** Spawns many rows through a cast that claims another shape for the iterated storage on the second row visited only, after the first row finished. */
export function spawnManyThroughLieOnLaterRow(): Outcome {
  const { storage, others, ids } = setup();
  const lie = storage as unknown as Storage<typeof OtherShape>;
  return outcome(storage, others, ids, () => {
    each(storage, (e) => {
      e.LyingSpot.x += 100;
      if (e.LyingSpot.x === 101) spawnMany(lie, 1);
      e.LyingSpot.x += 1000;
    });
  });
}

/** Spawns into a truthfully typed storage of another shape, then through a cast that claims that shape for the iterated one. */
export function spawnAfterTruth(): Outcome {
  const { storage, others, ids } = setup();
  const lie = storage as unknown as Storage<typeof OtherShape>;
  return outcome(storage, others, ids, () => {
    each(storage, (e) => {
      e.LyingSpot.x += 100;
      spawn(others);
      spawn(lie);
      e.LyingSpot.x += 1000;
    });
  });
}

/** Spawns many rows into a truthfully typed storage of another shape, then through a cast that claims that shape for the iterated one. */
export function spawnManyAfterTruth(): Outcome {
  const { storage, others, ids } = setup();
  const lie = storage as unknown as Storage<typeof OtherShape>;
  return outcome(storage, others, ids, () => {
    each(storage, (e) => {
      e.LyingSpot.x += 100;
      spawnMany(others, 2);
      spawnMany(lie, 1);
      e.LyingSpot.x += 1000;
    });
  });
}

/** Spawns through a cast that claims a same-named component with another field for the iterated storage. */
export function spawnThroughTwin(): Outcome {
  const { storage, others, ids } = setup();
  const lie = storage as unknown as Storage<typeof TwinShape>;
  return outcome(storage, others, ids, () => {
    each(storage, (e) => {
      e.LyingSpot.x += 100;
      spawn(lie);
      e.LyingSpot.x += 1000;
    });
  });
}

/** Spawns many rows through a cast that claims a same-named component with another field for the iterated storage. */
export function spawnManyThroughTwin(): Outcome {
  const { storage, others, ids } = setup();
  const lie = storage as unknown as Storage<typeof TwinShape>;
  return outcome(storage, others, ids, () => {
    each(storage, (e) => {
      e.LyingSpot.x += 100;
      spawnMany(lie, 1);
      e.LyingSpot.x += 1000;
    });
  });
}
