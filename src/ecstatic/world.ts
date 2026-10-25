/**
 * World system: persistent entities and component storage per archetype.
 *
 * A world is a collection of storage objects, one per registered archetype.
 * Entity IDs are global per world (0-based index + generation counter).
 * All state is mutable; world operations (spawn, despawn, set) mutate storages in place.
 */

import type { ArchetypeDescriptor, ArchetypeRef, ComponentDescriptor } from "./archetype.js";
import { resolveArchetype } from "./archetype.js";
import { NO_FREE_SLOT } from "./entity-id.js";
import { despawnMany } from "./entity/despawn.js";
import type { RelationReverseMap } from "./entity/reverse-map.js";
import { ERROR_WORLD_DESTROYED } from "./errors.js";
import type { Matcher } from "./matcher.js";
import type { RelationDescriptor } from "./relation.js";
import { getRelationMeta } from "./relation.js";

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

  /**
   * Entity ID table for staleness checks: the occupant's full packed ID per index, or, while the
   * slot is on the freelist, the slot's next ID — negated when that generation wrapped back to 1
   */
  generation: Float64Array;

  /** Sparse table: entity index → dense row; dead slots hold the freelist next pointer */
  sparse: Int32Array;

  /** Freelist head: -1 if empty, otherwise first free index */
  freeHead: number;

  /** Next fresh index to allocate (when freelist is empty) */
  nextIndex: number;

  /** Resource ID → data record, created on first access from the registered defaults */
  resources: Map<number, Record<string, unknown>>;

  /** Relation descriptors registered in this world (deduped across archetypes) */
  relations: RelationDescriptor[];

  /** True once any registered archetype carries a relation */
  hasAnyRelations: boolean;

  /** Relation → reverse index (target index → source bucket; key -1 = single-storage flag) */
  readonly reverseMap: Map<ComponentDescriptor, RelationReverseMap>;

  /** Highest target index that ever received a reverse entry (-1 = none) */
  maxTargetIndex: number;

  /**
   * Bumped whenever the archetype set changes (register/destroyWorld);
   * cached query resolutions compare against it before reuse.
   */
  queryEpoch: number;

  /** Set by `destroyWorld`; `register`/`getStorage` throw once present. */
  destroyed?: true;
}

/**
 * SoA (Structure of Arrays) columns for a component:
 * Record mapping field name → column array (TypedArray or plain Array).
 */
export type SoAColumns = Record<string, TypedArray | Array<unknown>>;

/** Union of typed-array types used for numeric and boolean SoA columns. */
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
 * One field's column: the field name and the array currently storing it.
 * Growth swaps the new array into the same object, so accessors that captured
 * it keep reading the current column. View accessors read `column.array` — a
 * named load on a map shared by every field column — instead of keying into
 * the column record by field name, which would make the lookup megamorphic and
 * tie its speed to unrelated objects whose keys overlap the field names.
 */
export class FieldColumn {
  readonly field: string;
  array: TypedArray | Array<unknown>;

  /** Creates the column for field `field`, backed by `array`. */
  constructor(field: string, array: TypedArray | Array<unknown>) {
    this.field = field;
    this.array = array;
  }
}

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

  /** Registered bitmask matchers, deduped by (all, any, none) triple */
  matchers: Matcher[];

  /**
   * Flat parallel view over `matchers[]`: `matcherMatched[i]` is always the
   * same object as `matchers[i].matched` (both rebuilt together on growth,
   * mirroring the flatColumns pattern).
   */
  matcherMatched: Uint8Array[];

  /** Map of component → SoA columns for that component */
  columns: Map<ComponentDescriptor, SoAColumns>;

  /** Flat list of all columns (for swap-and-pop despawn loops) */
  flatColumns: (TypedArray | Array<unknown>)[];

  /**
   * Component → one field column per declared field, in `__ecstatic_fields`
   * order. Refreshed on growth alongside `flatColumns`, so view accessors that
   * captured a field column read the new arrays.
   */
  readonly fieldColumns: Map<ComponentDescriptor, FieldColumn[]>;

  /** World arrays cached (aliases for generation and sparse) */
  generation: Float64Array;
  sparse: Int32Array;

  /** Ref-marked columns whose freed slots are cleared on despawn (GC release) */
  despawnClear: Array<unknown>[];
  hasDespawnClear: boolean;

  /**
   * True when any optional component carries data fields — spawn must
   * pre-populate optional defaults. Tag-only optionals don't set it: the
   * default fill is a no-op for them, so they must not pay for it.
   */
  hasOptionalData: boolean;

  /**
   * Pre-computed relation target columns, parallel with `relationDescriptors`
   * and `relationOptionalBits` (0 for required relations, the presence bit for
   * optionals) — iterating only relations keeps despawn source cleanup free of
   * per-component descriptor checks. Refreshed on storage growth alongside
   * `flatColumns`.
   */
  relationTargetColumns: Float64Array[];
  relationDescriptors: ComponentDescriptor[];
  relationOptionalBits: number[];
  relationN: number;

  /** True when the archetype carries any relation (required or optional) */
  hasRelations: boolean;

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
 * Internal view of Storage used only by world lifecycle functions: exposes
 * `world` as mutable and possibly `undefined` to represent a storage detached
 * by destroyWorld, without weakening the public `Storage.world` contract.
 */
interface MutableStorage extends Omit<Storage, "world"> {
  world: WorldState | undefined;
}

/**
 * Create a new world with initial capacity.
 *
 * @returns A fresh world with `INITIAL_WORLD_CAPACITY` entity slots pre-allocated, no archetype
 *   registered, and an empty freelist; the caller owns it and releases it with `destroyWorld`.
 */
export function createWorld(): World {
  const state: WorldState = {
    storages: new Map(),
    entityArch: Array.from({ length: INITIAL_WORLD_CAPACITY }),
    generation: new Float64Array(INITIAL_WORLD_CAPACITY),
    sparse: new Int32Array(INITIAL_WORLD_CAPACITY),
    freeHead: NO_FREE_SLOT,
    nextIndex: 0,
    resources: new Map(),
    relations: [],
    hasAnyRelations: false,
    reverseMap: new Map(),
    maxTargetIndex: -1,
    queryEpoch: 0,
  };

  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- opaque type return
  return state as World;
}

/**
 * Register an archetype with a world, creating storage for that archetype.
 * Idempotent: registering the same archetype twice returns the same storage object.
 *
 * @param world - World that will own the storage; must not have been destroyed.
 * @param arch - The archetype descriptor, or a class extending `Archetype()`, to register.
 * @returns The storage for this archetype in this world — the same object on every call for the
 *   same archetype, empty when newly created.
 * @throws If the world is destroyed
 * @throws If the class form is an `Archetype()` result that was never subclassed, or an
 *   indirect subclass of one
 */
export function register<A extends ArchetypeDescriptor>(
  world: World,
  arch: ArchetypeRef<A>,
): Storage<A>;
export function register(world: World, arch: ArchetypeRef): Storage {
  const state = world as WorldState;

  if (state.destroyed) {
    throw new Error(ERROR_WORLD_DESTROYED);
  }

  const descriptor = resolveArchetype(arch);

  const existing = state.storages.get(descriptor.id);
  if (existing !== undefined) {
    return existing;
  }

  const storage = createStorage(state, descriptor);

  state.storages.set(descriptor.id, storage);

  // Archetype set changed: cached query resolutions must re-resolve.
  state.queryEpoch += 1;

  return storage;
}

/**
 * Retrieve the storage for an archetype in a world.
 *
 * @param world - World the archetype was registered in; must not have been destroyed.
 * @param arch - The archetype descriptor, or a class extending `Archetype()`, to look up.
 * @returns The storage `register` created for this archetype — the same object `register`
 *   returned, never a copy.
 * @throws If the world is destroyed
 * @throws If the archetype is not registered in this world
 * @throws If the class form is an `Archetype()` result that was never subclassed, or an
 *   indirect subclass of one
 */
export function getStorage<A extends ArchetypeDescriptor>(
  world: World,
  arch: ArchetypeRef<A>,
): Storage<A>;
export function getStorage(world: World, arch: ArchetypeRef): Storage {
  const state = world as WorldState;

  if (state.destroyed) {
    throw new Error(ERROR_WORLD_DESTROYED);
  }

  const storage = state.storages.get(resolveArchetype(arch).id);
  if (storage === undefined) {
    throw new Error("archetype not registered in this world");
  }

  return storage;
}

/**
 * Flatten a storage's per-component SoA columns into a single array for
 * cheap iteration (e.g. capacity checks, grow loops).
 *
 * @param columns - One storage's component → SoA column-record map.
 * @returns A fresh array of every column across all components, in map then field order; the
 *   column arrays themselves are shared with `columns`, not copied.
 */
function collectFlatColumns(
  columns: Map<ComponentDescriptor, SoAColumns>,
): (TypedArray | Array<unknown>)[] {
  const flatColumns: (TypedArray | Array<unknown>)[] = [];
  for (const soa of columns.values()) {
    for (const col of Object.values(soa)) {
      flatColumns.push(col);
    }
  }
  return flatColumns;
}

/**
 * Look up a declared field's column in a component's column record.
 *
 * @param soa - The component's column record.
 * @param fieldName - A declared field of the component.
 * @returns The field's current column array.
 * @throws If the field has no column (invariant guard, unreachable)
 */
function requireColumn(soa: SoAColumns, fieldName: string): TypedArray | Array<unknown> {
  const col = soa[fieldName];
  /* istanbul ignore next */
  if (col === undefined) throw new Error("invariant: declared field has no column");
  return col;
}

/**
 * Build one field column per declared field of every column-carrying component.
 *
 * @param columns - One storage's component → SoA column-record map.
 * @returns A fresh component → field-columns map, each list in the component's
 *   `__ecstatic_fields` order and backed by the arrays currently in `columns`.
 * @throws If a declared field has no column (invariant guard, unreachable)
 */
function collectFieldColumns(
  columns: Map<ComponentDescriptor, SoAColumns>,
): Map<ComponentDescriptor, FieldColumn[]> {
  const fieldColumns = new Map<ComponentDescriptor, FieldColumn[]>();
  for (const [comp, soa] of columns) {
    fieldColumns.set(
      comp,
      comp.__ecstatic_fields.map(
        (fieldName) => new FieldColumn(fieldName, requireColumn(soa, fieldName)),
      ),
    );
  }
  return fieldColumns;
}

/**
 * Bring a storage's column caches back in line with its column records after growth replaced
 * column arrays: `flatColumns` is rebuilt and every field column is pointed at its field's new
 * array.
 *
 * @param storage - Storage whose `flatColumns` is replaced and whose `fieldColumns` are updated
 *   in place from `columns`; the field column objects themselves are kept, so accessors holding
 *   them read the new arrays.
 * @throws If a field column's component or field has no column array (invariant guard,
 *   unreachable)
 */
export function syncColumnCaches(storage: Storage): void {
  storage.flatColumns = collectFlatColumns(storage.columns);
  for (const [comp, fieldColumns] of storage.fieldColumns) {
    const soa = storage.columns.get(comp);
    /* istanbul ignore next */
    if (soa === undefined) throw new Error("invariant: field columns without a column record");
    for (const column of fieldColumns) {
      column.array = requireColumn(soa, column.field);
    }
  }
}

/**
 * Track an archetype's relation descriptors in the world for later
 * reverse-map operations (deduped across archetypes, reverse-map entries
 * pre-initialized).
 *
 * @param state - World whose `relations`, `reverseMap`, and `hasAnyRelations` are updated.
 * @param arch - Archetype being registered; both its required and optional components are scanned.
 * @returns `true` when the archetype carries any relation, required or optional.
 */
function registerWorldRelations(state: WorldState, arch: ArchetypeDescriptor): boolean {
  let hasRelations = false;
  for (const comp of [...arch.components, ...arch.optionals]) {
    const relMeta = getRelationMeta(comp);
    if (relMeta !== undefined) {
      hasRelations = true;
      state.hasAnyRelations = true;
      if (!state.relations.includes(relMeta)) {
        state.relations.push(relMeta);
        state.reverseMap.set(relMeta, new Map());
      }
    }
  }
  return hasRelations;
}

/** The parallel relation bookkeeping arrays of a storage (see Storage docs). */
interface RelationColumns {
  relationTargetColumns: Float64Array[];
  relationDescriptors: ComponentDescriptor[];
  relationOptionalBits: number[];
}

/**
 * Pre-compute the relation target columns for fast despawn source cleanup:
 * required relations first (bit 0), then optionals with their presence bit.
 *
 * @param arch - Archetype whose required and optional relations are collected.
 * @param columns - The storage's component → SoA map; each relation's `target` column is taken
 *   from here, so the returned columns alias the storage's.
 * @returns Three freshly allocated parallel arrays — target columns, descriptors, and the
 *   presence bit (0 for required relations) — aligned by index.
 */
function collectRelationColumns(
  arch: ArchetypeDescriptor,
  columns: Map<ComponentDescriptor, SoAColumns>,
): RelationColumns {
  const relationTargetColumns: Float64Array[] = [];
  const relationDescriptors: ComponentDescriptor[] = [];
  const relationOptionalBits: number[] = [];

  for (const comp of arch.components) {
    if (getRelationMeta(comp) !== undefined) {
      const targetCol = columns.get(comp)?.["target"];
      if (targetCol instanceof Float64Array) {
        relationTargetColumns.push(targetCol);
        relationDescriptors.push(comp);
        relationOptionalBits.push(0);
      }
    }
  }
  for (const comp of arch.optionals) {
    if (getRelationMeta(comp) !== undefined) {
      const targetCol = columns.get(comp)?.["target"];
      const optBit = arch.optionalBitLookup.get(comp);
      if (targetCol instanceof Float64Array && optBit !== undefined) {
        relationTargetColumns.push(targetCol);
        relationDescriptors.push(comp);
        relationOptionalBits.push(optBit);
      }
    }
  }

  return { relationTargetColumns, relationDescriptors, relationOptionalBits };
}

/**
 * Build the SoA columns for every column-carrying component of an archetype,
 * collecting the reference columns despawn must clear.
 *
 * Part of the runtime contract with the optimizer: a component's SoA record is
 * created here, once per storage, and never replaced. Growth swaps the arrays inside it, so code
 * that holds the record across a spawn still reads current columns.
 *
 * @param arch - Archetype whose components get columns; tag-only optionals get none.
 * @returns `columns`: component → SoA map with every column sized to `INITIAL_ARCH_CAPACITY`;
 *   `despawnClear`: the plain-array columns of reference-marked fields, whose freed slots are
 *   cleared on despawn.
 * @throws If a reference mark has no matching field name (invariant guard, unreachable)
 */
function buildColumns(arch: ArchetypeDescriptor): {
  columns: Map<ComponentDescriptor, SoAColumns>;
  despawnClear: Array<unknown>[];
} {
  const columns = new Map<ComponentDescriptor, SoAColumns>();
  const despawnClear: Array<unknown>[] = [];

  // Relations always need columns (for the target field); data-carrying
  // optionals need columns for their fields. Pure tag optionals get none.
  const allComps = [
    ...arch.components,
    ...arch.optionals.filter(
      (opt) => opt.__ecstatic_fields.length > 0 || getRelationMeta(opt) !== undefined,
    ),
  ];

  for (const comp of allComps) {
    const soa = createSoA(comp, INITIAL_ARCH_CAPACITY);
    columns.set(comp, soa);

    const isRef = comp.__ecstatic_is_reference;
    const fields = comp.__ecstatic_fields;

    for (let i = 0; i < fields.length; i++) {
      if (isRef[i] !== true) continue;
      const fieldName = fields[i];
      /* istanbul ignore next */
      if (fieldName === undefined) throw new Error("invariant: field index out of bounds");
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- ref column is always plain array
      despawnClear.push(soa[fieldName] as Array<unknown>);
    }
  }

  return { columns, despawnClear };
}

/**
 * Build the storage for an archetype in a world, with each column-carrying component's SoA
 * record also aliased as `storage[name]`.
 *
 * Part of the runtime contract with the optimizer:
 *
 * - **The per-component alias.** `storage[name]` is the same object as
 *   `storage.columns.get(component)` for every component that has a record. No runtime code
 *   reads it; generated code does. Every own property of `Object.prototype` is a reserved
 *   component name, so this write cannot replace the storage's prototype through `__proto__`
 *   or shadow an inherited method.
 * - **Filter resolution inputs are fixed.** `componentByName`, `componentLookup`,
 *   `optionalBitLookup`, and `optionalNotBitLookup` are set here and never change, so a filter
 *   resolves the same way for the storage's whole life.
 *
 * @param state - World the storage belongs to; its relation registry is updated.
 * @param arch - Archetype whose components get columns and aliases.
 * @returns The new storage, empty and sized to `INITIAL_ARCH_CAPACITY`.
 * @throws If a component's declared fields and columns disagree (invariant guard, unreachable)
 */
function createStorage(state: WorldState, arch: ArchetypeDescriptor): Storage {
  const { columns, despawnClear } = buildColumns(arch);

  const flatColumns = collectFlatColumns(columns);

  const hasRelations = registerWorldRelations(state, arch);
  const { relationTargetColumns, relationDescriptors, relationOptionalBits } =
    collectRelationColumns(arch, columns);

  const storage = {
    id: arch.id,
    world: state,
    archetype: arch,
    entities: new Float64Array(INITIAL_ARCH_CAPACITY),
    n: 0,
    mask: new Uint32Array(INITIAL_ARCH_CAPACITY),
    matchers: [],
    matcherMatched: [],
    columns,
    flatColumns,
    fieldColumns: collectFieldColumns(columns),
    generation: state.generation,
    sparse: state.sparse,
    despawnClear,
    hasDespawnClear: despawnClear.length > 0,
    // Optional relations need the default fill for sentinel target-column init
    // even when they carry no data fields.
    hasOptionalData: arch.optionals.some(
      (opt) => opt.__ecstatic_fields.length > 0 || getRelationMeta(opt) !== undefined,
    ),
    relationTargetColumns,
    relationDescriptors,
    relationOptionalBits,
    relationN: relationDescriptors.length,
    hasRelations,
    componentByName: arch.componentByName,
    componentLookup: arch.componentLookup,
    optionalBitLookup: arch.optionalBitLookup,
    optionalNotBitLookup: arch.optionalNotBitLookup,
  } as Storage;

  for (const comp of [...arch.components, ...arch.optionals]) {
    const soa = columns.get(comp);
    if (soa !== undefined) {
      (storage as Record<string, unknown>)[comp.__ecstatic_name] = soa;
    }
  }

  return storage;
}

/**
 * Create a SoA (Structure of Arrays) for a component's fields.
 *
 * @param comp - Component whose declared fields become columns: width-marked and boolean fields
 *   get typed arrays, ref and string fields plain arrays, and a relation gets an extra `target`
 *   Float64Array outside its declared fields.
 * @param capacity - Initial length of every column, in rows.
 * @returns A fresh column record keyed by field name (plus `target` for relations).
 * @throws If the field list has a hole (invariant guard, unreachable)
 */
function createSoA(comp: ComponentDescriptor, capacity: number): SoAColumns {
  const fields = comp.__ecstatic_fields;
  const columnCtors = comp.__ecstatic_column_ctor ?? [];

  const soa: SoAColumns = {};

  for (let i = 0; i < fields.length; i++) {
    const fieldName = fields[i];
    /* istanbul ignore next */
    if (fieldName === undefined) throw new Error("invariant: field index out of bounds");
    const ctor = columnCtors[i];

    if (ctor !== undefined) {
      // Width-marked field or boolean: use typed array
      soa[fieldName] = new ctor(capacity);
    } else {
      // Ref or string field: use plain array
      soa[fieldName] = Array.from({ length: capacity });
    }
  }

  // Relations get a `target` column outside __ecstatic_fields: packed entity
  // ids are floats, same as storage.entities.
  if (getRelationMeta(comp) !== undefined) {
    soa["target"] = new Float64Array(capacity);
  }

  return soa;
}

/**
 * Destroy a world: despawn all entities, reset state, mark as destroyed.
 *
 * Subsequent calls to register() or getStorage() will error unconditionally.
 * Calling destroyWorld twice is a no-op (not an error).
 *
 * @param world - World to tear down: every storage is emptied and detached (its `world` backref
 *   set to `undefined`) and the world's own tables are reset; a world already destroyed is left
 *   as is.
 */
export function destroyWorld(world: World): void {
  const state = world as WorldState;

  if (state.destroyed) {
    return;
  }

  // Despawn all entities from all storages (advance generations to invalidate
  // IDs), then disconnect each storage so operations on a detached storage fail.
  for (const storage of state.storages.values()) {
    despawnMany(storage);
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- opaque field mutation
    (storage as MutableStorage).world = undefined;
  }

  state.storages.clear();
  state.entityArch = Array.from({ length: INITIAL_WORLD_CAPACITY });
  state.generation = new Float64Array(INITIAL_WORLD_CAPACITY);
  state.sparse = new Int32Array(INITIAL_WORLD_CAPACITY);
  state.freeHead = NO_FREE_SLOT;
  state.nextIndex = 0;
  state.resources.clear();
  state.relations = [];
  state.hasAnyRelations = false;
  state.reverseMap.clear();
  state.maxTargetIndex = -1;
  state.queryEpoch += 1;

  // Mark as destroyed so register/getStorage will error
  state.destroyed = true;
}
