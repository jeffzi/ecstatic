/**
 * The operations the allocation gate measures, keyed by budget-table name.
 *
 * Each builder returns a world and a steady-state body: whatever the body
 * changes, it changes back before returning, so successive rounds see the same
 * world. Every body runs its operation `DEFAULT_N` times (or once over a
 * `DEFAULT_N`-entity population), which is the divisor the gate reports
 * bytes/op against.
 */

import {
  alive,
  countSources,
  createWorld,
  despawn,
  despawnMany,
  disable,
  each,
  enable,
  type EntityId,
  get,
  getResource,
  getSources,
  getTarget,
  has,
  hasAny,
  hasSources,
  link,
  query,
  querySources,
  register,
  resetResource,
  set,
  setResource,
  spawn,
  spawnMany,
  unlink,
  type World,
} from "ecstatic";

import {
  Alive,
  Follows,
  linkArch,
  Owner,
  ownedArch,
  Position,
  Score,
  Shield,
  spawnArch,
  tagArch,
  Velocity,
} from "../archetypes.js";
import { benchCreateWorld, DEFAULT_N } from "../helpers.js";

/** A gated op: the world it runs against and the steady-state body measured over `DEFAULT_N`. */
export interface AllocOp {
  world: World;
  body: () => void;
}

/** Builds a fresh op — the gate calls it once per measured op in a fresh process, so builders must not share mutable state. */
export type OpBuilder = () => AllocOp;

/**
 * Accumulator for every read. Module-scope binding captured by closures
 * below; V8 cannot elide the writes because the variable escapes into
 * closures that outlive the initializer.
 */
let sink = 0;

/** N optional-relation sources plus one shared target; `linked` links every source in setup. */
function linkedWorld(linked: boolean): { world: World; sources: EntityId[]; target: EntityId } {
  const world = createWorld();
  const storage = register(world, linkArch);
  const target = spawn(storage);
  const sources: EntityId[] = [];
  for (let i = 0; i < DEFAULT_N; i++) sources.push(spawn(storage));
  if (linked) for (const id of sources) link(world, id, Owner, target);
  return { world, sources, target };
}

const iterationOps: Record<string, OpBuilder> = {
  each_all() {
    const { world, trackedStorage: storage } = benchCreateWorld({ noBackground: true });
    const body = (): void => {
      each(storage, (e) => {
        sink += e.Position.x;
      });
    };
    return { world, body };
  },
  each_filtered() {
    const { world, trackedStorage: storage, tracked } = benchCreateWorld({ noBackground: true });
    tracked.forEach((id, i) => {
      if (i % 2 === 0) enable(storage, id, Alive);
    });
    const body = (): void => {
      each(storage, [Alive], (e) => {
        sink += e.Position.x;
      });
    };
    return { world, body };
  },
  query_hot() {
    const { world } = benchCreateWorld();
    const body = (): void => {
      query(world, [Position, Velocity], (e) => {
        sink += e.Position.x;
      });
    };
    return { world, body };
  },
};

const accessOps: Record<string, OpBuilder> = {
  get_1field() {
    const { world, trackedStorage: storage, tracked } = benchCreateWorld();
    const body = (): void => {
      for (const id of tracked) sink += get(storage, id, Position.x);
    };
    return { world, body };
  },
  get_2field() {
    const { world, trackedStorage: storage, tracked } = benchCreateWorld();
    const body = (): void => {
      for (const id of tracked) sink += get(storage, id, Position.x) + get(storage, id, Position.y);
    };
    return { world, body };
  },
  set_1field() {
    const { world, trackedStorage: storage, tracked } = benchCreateWorld();
    const body = (): void => {
      for (const id of tracked) set(storage, id, Position.x, get(storage, id, Position.x));
    };
    return { world, body };
  },
  set_record() {
    const { world, trackedStorage: storage, tracked } = benchCreateWorld();
    const values = { x: 1, y: 2 };
    const body = (): void => {
      for (const id of tracked) set(storage, id, Position, values);
    };
    return { world, body };
  },
  has() {
    const { world, trackedStorage: storage, tracked } = benchCreateWorld();
    const body = (): void => {
      for (const id of tracked) if (has(storage, id, Alive)) sink += 1;
    };
    return { world, body };
  },
  has_any() {
    const { world, trackedStorage: storage, tracked } = benchCreateWorld();
    const comps: [typeof Alive] = [Alive];
    const body = (): void => {
      for (const id of tracked) if (hasAny(storage, id, comps)) sink += 1;
    };
    return { world, body };
  },
  alive() {
    const { world, trackedStorage: storage, tracked } = benchCreateWorld();
    const body = (): void => {
      for (const id of tracked) if (alive(storage, id)) sink += 1;
    };
    return { world, body };
  },
};

/** `enable` and `disable` share one toggle body: neither can be steady-state alone. */
function toggleOp(): AllocOp {
  const { world, trackedStorage: storage, tracked } = benchCreateWorld();
  const body = (): void => {
    for (const id of tracked) enable(storage, id, Alive);
    for (const id of tracked) disable(storage, id, Alive);
  };
  return { world, body };
}

const optionalOps: Record<string, OpBuilder> = {
  enable: toggleOp,
  disable: toggleOp,
  enable_data() {
    const world = createWorld();
    const storage = register(world, tagArch);
    const ids: EntityId[] = Array.from({ length: DEFAULT_N }, () => spawn(storage));
    const values = { hp: 5 };
    const body = (): void => {
      for (const id of ids) enable(storage, id, Shield, values);
      for (const id of ids) disable(storage, id, Shield);
    };
    return { world, body };
  },
};

const lifecycleOps: Record<string, OpBuilder> = {
  spawn_despawn() {
    const world = createWorld();
    const storage = register(world, spawnArch);
    const ids: EntityId[] = Array.from({ length: DEFAULT_N }, () => spawn(storage));
    despawnMany(storage, ids);
    const body = (): void => {
      for (let i = 0; i < DEFAULT_N; i++) ids[i] = spawn(storage);
      for (const id of ids) despawn(storage, id);
    };
    return { world, body };
  },
  spawn_despawn_many() {
    const world = createWorld();
    const storage = register(world, spawnArch);
    const body = (): void => {
      spawnMany(storage, DEFAULT_N);
      despawnMany(storage);
    };
    return { world, body };
  },
  spawn_despawn_many_out() {
    const world = createWorld();
    const storage = register(world, spawnArch);
    const out: EntityId[] = Array.from({ length: DEFAULT_N }, () => spawn(storage));
    despawnMany(storage, out);
    const body = (): void => {
      spawnMany(storage, DEFAULT_N, out);
      despawnMany(storage, out);
    };
    return { world, body };
  },
};

const resourceOps: Record<string, OpBuilder> = {
  resource_get() {
    const world = createWorld();
    const body = (): void => {
      for (let i = 0; i < DEFAULT_N; i++) sink += getResource(world, Score).value;
    };
    return { world, body };
  },
  resource_set() {
    const world = createWorld();
    const values = { value: 1 };
    const body = (): void => {
      for (let i = 0; i < DEFAULT_N; i++) setResource(world, Score, values);
    };
    return { world, body };
  },
  resource_reset() {
    const world = createWorld();
    const body = (): void => {
      for (let i = 0; i < DEFAULT_N; i++) resetResource(world, Score);
    };
    return { world, body };
  },
};

/** `link` and `unlink` share one pair body: neither can be steady-state alone. */
function linkUnlinkOp(): AllocOp {
  const { world, sources, target } = linkedWorld(false);
  const body = (): void => {
    for (const id of sources) link(world, id, Owner, target);
    for (const id of sources) unlink(world, id, Owner);
  };
  return { world, body };
}

const relationOps: Record<string, OpBuilder> = {
  rel_link: linkUnlinkOp,
  rel_unlink: linkUnlinkOp,
  rel_link_with_data() {
    const { world, sources, target } = linkedWorld(false);
    const values = { offset: 3 };
    const body = (): void => {
      for (const id of sources) link(world, id, Follows, target, values);
      for (const id of sources) unlink(world, id, Follows);
    };
    return { world, body };
  },
  rel_get_target() {
    const { world, sources, target } = linkedWorld(true);
    const body = (): void => {
      for (const id of sources) if (getTarget(world, id, Owner) === target) sink += 1;
    };
    return { world, body };
  },
  rel_count_sources() {
    const { world, target } = linkedWorld(true);
    const body = (): void => {
      for (let i = 0; i < DEFAULT_N; i++) sink += countSources(world, Owner, target);
    };
    return { world, body };
  },
  rel_has_sources() {
    const { world, target } = linkedWorld(true);
    const body = (): void => {
      for (let i = 0; i < DEFAULT_N; i++) if (hasSources(world, Owner, target)) sink += 1;
    };
    return { world, body };
  },
  rel_query_sources() {
    const { world, target } = linkedWorld(true);
    const body = (): void => {
      querySources(world, Owner, target, (e) => {
        sink += e.id;
      });
    };
    return { world, body };
  },
  rel_get_sources() {
    const { world, target } = linkedWorld(true);
    const out: EntityId[] = [];
    const body = (): void => {
      sink += getSources(world, Owner, target, out).length;
    };
    return { world, body };
  },
  rel_spawn_despawn() {
    const world = createWorld();
    const targets = register(world, linkArch);
    const storage = register(world, ownedArch);
    const overrides = { Follows: { target: spawn(targets) } };
    const ids: EntityId[] = Array.from({ length: DEFAULT_N }, () => spawn(storage, overrides));
    despawnMany(storage, ids);
    const body = (): void => {
      for (let i = 0; i < DEFAULT_N; i++) ids[i] = spawn(storage, overrides);
      for (const id of ids) despawn(storage, id);
    };
    return { world, body };
  },
};

/** Every gated op, keyed by its `ALLOC_BUDGETS` name. */
export const ALLOC_OPS: Readonly<Record<string, OpBuilder>> = {
  ...iterationOps,
  ...accessOps,
  ...optionalOps,
  ...lifecycleOps,
  ...resourceOps,
  ...relationOps,
};
