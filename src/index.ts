export const VERSION = "0.1.0";

export type { ArchetypeDescriptor, ComponentsOf } from "./archetype.js";
// Archetype system
export { archetype } from "./archetype.js";
// Component system
export {
  type Component,
  type ComponentDescriptor,
  type ComponentFields,
  component,
  components,
  type FieldDescriptor,
  type FieldValue,
  f32,
  i8,
  i16,
  i32,
  type RefMarker,
  ref,
  type Tag,
  u8,
  u16,
  u32,
} from "./component.js";
// Entity operations
export { get, set } from "./entity/access.js";
export { alive } from "./entity/common.js";
export { despawn, despawnMany } from "./entity/despawn.js";
export { type EachView, each } from "./entity/each.js";
export { type SpawnOverrides, spawn, spawnMany } from "./entity/spawn.js";
// Entity IDs
export type { EntityId } from "./entity-id.js";
export type { Storage, World } from "./world.js";
// World system
export { createWorld, destroyWorld, getStorage, register } from "./world.js";
