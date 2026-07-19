/**
 * World system: persistent entities and component storage per archetype.
 *
 * A world is a collection of storage objects, one per registered archetype.
 * Entity IDs are global per world (0-based index + generation counter).
 * All state is mutable; world operations (spawn, despawn, set) mutate storages in place.
 */

import type { ArchetypeDescriptor, ComponentDescriptor } from "./archetype.js";
import { despawnMany } from "./entity/despawn.js";
import { ERROR_WORLD_DESTROYED } from "./errors.js";

/**
 * Initial world capacity: number of entity slots pre-allocated.
 */
const INITIAL_WORLD_CAPACITY = 256;

/**
 * Initial archetype storage capacity: number of entity slots per storage.
 */
const INITIAL_ARCH_CAPACITY = 8;

/**
 * Internal world state (opaque to callers; cast from World type).
 */
export interface WorldState {
  /** Map of archetype id → storage for that archetype in this world */
  readonly storages: Map<number, Storage>;

  /** Inverse lookup: entity index → storage (or undefined if unused) */
  entityArch: (Storage | undefined)[];

  /** Entity ID table: stores the full packed ID per index for staleness checks */
  generation: Float64Array;

  /** Sparse table: entity index → dense row; dead slots hold the freelist next pointer */
  sparse: Int32Array;

  /** Freelist head: -1 if empty, otherwise first free index */
  freeHead: number;

  /** Next fresh index to allocate (when freelist is empty) */
  nextIndex: number;

  /** Destroyed flag: set when world is destroyed (later task) */
  destroyed?: true;
}

/**
 * SoA (Structure of Arrays) columns for a component:
 * Record mapping field name → column array (TypedArray or plain Array).
 */
export type SoAColumns = Record<string, TypedArray | Array<unknown>>;

export type TypedArray =
  | Float64Array
  | Float32Array
  | Int32Array
  | Int16Array
  | Int8Array
  | Uint32Array
  | Uint16Array
  | Uint8Array;

/**
 * Internal storage state for a single archetype in a single world.
 * The A parameter threads the registered archetype's component tuple
 * to spawn overrides, get/set, and each views.
 */
export interface Storage<A extends ArchetypeDescriptor = ArchetypeDescriptor> {
  /** ID of this storage (same as archetype.id) */
  readonly id: number;

  /** World this storage belongs to */
  readonly world: WorldState;

  /** Archetype descriptor (cached for API calls) */
  readonly archetype: A;

  /** Dense array of packed entity IDs (one per row, up to n entries) */
  entities: Float64Array;

  /** Number of live entities in this storage */
  n: number;

  /** Optional component bitmask per entity (one per row) */
  mask: Uint32Array;

  /** Map of component → SoA columns for that component */
  columns: Map<ComponentDescriptor, SoAColumns>;

  /** Flat list of all columns (for swap-and-pop despawn loops) */
  flatColumns: (TypedArray | Array<unknown>)[];

  /** World arrays cached (aliases for generation and sparse) */
  generation: Float64Array;
  sparse: Int32Array;

  /** Ref-marked columns whose freed slots are cleared on despawn (GC release) */
  despawnClear: Array<unknown>[];
  hasDespawnClear: boolean;

  /** Cached descriptor lookups for all components (required + optional) */
  readonly componentByName: Map<string, ComponentDescriptor>;
  readonly componentLookup: Set<ComponentDescriptor>;
  readonly optionalBitLookup: Map<ComponentDescriptor, number>;
  readonly optionalNotBitLookup: Map<ComponentDescriptor, number>;

  /** Named SoA aliases (e.g., storage.Position.x accesses the Position component's x column) */
  [componentName: string]: unknown;
}

/**
 * Opaque World type: cast to WorldState internally.
 * Prevents accidental mutation of world internals by callers.
 */
export type World = WorldState & { readonly __brand: "World" };

/**
 * Create a new world with initial capacity.
 *
 * @returns An opaque World object
 */
export function createWorld(): World {
  const state: WorldState = {
    storages: new Map(),
    entityArch: new Array(INITIAL_WORLD_CAPACITY),
    generation: new Float64Array(INITIAL_WORLD_CAPACITY),
    sparse: new Int32Array(INITIAL_WORLD_CAPACITY),
    freeHead: -1,
    nextIndex: 0,
  };

  return state as World;
}

/**
 * Register an archetype with a world, creating storage for that archetype.
 * Idempotent: registering the same archetype twice returns the same storage object.
 *
 * @param world - The world to register in
 * @param arch - The archetype descriptor to register
 * @returns The storage object for this archetype in this world
 *
 * @throws If the world is destroyed
 */
export function register<A extends ArchetypeDescriptor>(world: World, arch: A): Storage<A>;
export function register(world: World, arch: ArchetypeDescriptor): Storage {
  const state = world as WorldState;

  if (state.destroyed) {
    throw new Error(ERROR_WORLD_DESTROYED);
  }

  // Idempotent: return existing storage if already registered
  const existing = state.storages.get(arch.id);
  if (existing) {
    return existing;
  }

  // Create storage for this archetype
  const storage = createStorage(state, arch);

  // Cache it
  state.storages.set(arch.id, storage);

  return storage;
}

/**
 * Retrieve the storage for an archetype in a world.
 *
 * @param world - The world to query
 * @param arch - The archetype to look up
 * @returns The storage object (must be registered)
 *
 * @throws If the world is destroyed
 * @throws If the archetype is not registered in this world
 */
export function getStorage<A extends ArchetypeDescriptor>(world: World, arch: A): Storage<A>;
export function getStorage(world: World, arch: ArchetypeDescriptor): Storage {
  const state = world as WorldState;

  if (state.destroyed) {
    throw new Error(ERROR_WORLD_DESTROYED);
  }

  const storage = state.storages.get(arch.id);
  if (!storage) {
    throw new Error("archetype not registered in this world");
  }

  return storage;
}

/**
 * Create a storage object for a single archetype in a world.
 */
function createStorage(state: WorldState, arch: ArchetypeDescriptor): Storage {
  // Build columns for all required components
  const columns = new Map<ComponentDescriptor, SoAColumns>();
  const flatColumns: (TypedArray | Array<unknown>)[] = [];

  // Despawn-time cleanup tracking (ref-marked fields)
  const despawnClear: Array<unknown>[] = [];

  // Add columns for required and optional components
  const allComps = [
    ...arch.components,
    ...arch.optionals.filter((opt) => opt.__ecstatic_fields.length > 0),
  ];

  for (const comp of allComps) {
    const soa = createSoA(comp, INITIAL_ARCH_CAPACITY);
    columns.set(comp, soa);

    // Collect ref-marked columns for despawn cleanup
    const isRef = comp.__ecstatic_is_reference;
    const fields = comp.__ecstatic_fields;

    for (let i = 0; i < fields.length; i++) {
      if (isRef[i] === true) {
        despawnClear.push(soa[fields[i]!] as Array<unknown>);
      }
    }

    // Add all columns to flatColumns for iteration
    for (const col of Object.values(soa)) {
      flatColumns.push(col);
    }
  }

  // Create the storage object
  const storage = {
    id: arch.id,
    world: state,
    archetype: arch,
    entities: new Float64Array(INITIAL_ARCH_CAPACITY),
    n: 0,
    mask: new Uint32Array(INITIAL_ARCH_CAPACITY),
    columns,
    flatColumns,
    generation: state.generation,
    sparse: state.sparse,
    despawnClear,
    hasDespawnClear: despawnClear.length > 0,
    componentByName: arch.componentByName,
    componentLookup: arch.componentLookup,
    optionalBitLookup: arch.optionalBitLookup,
    optionalNotBitLookup: arch.optionalNotBitLookup,
  } as Storage;

  // Add named SoA aliases (e.g., storage.Position = soa)
  for (const comp of [...arch.components, ...arch.optionals]) {
    const soa = columns.get(comp);
    if (soa) {
      (storage as Record<string, unknown>)[comp.__ecstatic_name] = soa;
    }
  }

  return storage;
}

/**
 * Create a SoA (Structure of Arrays) for a component's fields.
 */
function createSoA(comp: ComponentDescriptor, capacity: number): SoAColumns {
  const fields = comp.__ecstatic_fields;
  const columnCtors = comp.__ecstatic_column_ctor ?? [];

  const soa: SoAColumns = {};

  for (let i = 0; i < fields.length; i++) {
    const fieldName = fields[i]!;
    const ctor = columnCtors[i];

    if (ctor) {
      // Width-marked field or boolean: use typed array
      soa[fieldName] = new ctor(capacity);
    } else {
      // Ref or string field: use plain array
      soa[fieldName] = new Array(capacity);
    }
  }

  return soa;
}

/**
 * Destroy a world: despawn all entities, reset state, mark as destroyed.
 *
 * Subsequent calls to register() or getStorage() will error unconditionally.
 * Calling destroyWorld twice is a no-op (not an error).
 *
 * @param world - The world to destroy
 */
export function destroyWorld(world: World): void {
  const state = world as WorldState;

  // No-op if already destroyed
  if (state.destroyed) {
    return;
  }

  // Despawn all entities from all storages (advance generations to invalidate
  // IDs), then disconnect each storage so operations on a detached storage fail.
  for (const storage of state.storages.values()) {
    despawnMany(storage);
    (storage as unknown as { world: WorldState | undefined }).world = undefined;
  }

  // Reset world state to initial capacity
  state.storages.clear();
  state.entityArch = new Array(INITIAL_WORLD_CAPACITY);
  state.generation = new Float64Array(INITIAL_WORLD_CAPACITY);
  state.sparse = new Int32Array(INITIAL_WORLD_CAPACITY);
  state.freeHead = -1;
  state.nextIndex = 0;

  // Mark as destroyed so register/getStorage will error
  state.destroyed = true;
}
