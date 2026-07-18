export const VERSION = "0.1.0";

export type { ArchetypeDescriptor } from "./archetype.js";
// Archetype system
export { archetype } from "./archetype.js";
// Component system
export {
  type ComponentDescriptor,
  component,
  components,
  type FieldDescriptor,
  f32,
  f64,
  i8,
  i16,
  i32,
  isComponentDescriptor,
  isFieldDescriptor,
  ref,
  u8,
  u16,
  u32,
} from "./component.js";
// Entity operations
export { alive } from "./entity/common.js";
export { despawn, despawnMany } from "./entity/despawn.js";
export { spawn, spawnMany } from "./entity/spawn.js";
// Entity IDs
export type { EntityId } from "./entity-id.js";
export { entityGen, entityIndex, initialEntityId, MAX_INDEX } from "./entity-id.js";
export type { World } from "./world.js";
// World system
export { createWorld, destroyWorld, getStorage, register } from "./world.js";
